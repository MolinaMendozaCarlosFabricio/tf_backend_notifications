import { Channel, ConsumeMessage } from 'amqplib';
import { ZodError } from 'zod';
import { NotificationPayloadSchema } from '../dtos/notification.dto';
import { persistFanOut } from '../services/notification.service';
import { sendToRecipients } from '../services/fcm.service';
import { QUEUES } from './rabbitClient';

function formatZodError(err: ZodError): string {
  return err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
}

export async function startNotificationConsumer(channel: Channel): Promise<void> {
  console.log(`[consumer] Listening on queue: ${QUEUES.MAIN}`);

  await channel.consume(QUEUES.MAIN, async (msg: ConsumeMessage | null) => {
    if (msg === null) {
      console.warn('[consumer] Consumer cancelled by broker');
      return;
    }

    const rawContent = msg.content.toString();
    console.log(`[consumer] Mensaje recibido: ${rawContent.slice(0, 150)}`);

    // Step 1: Parse JSON — malformed JSON is unretriable, ACK and discard
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(rawContent);
    } catch {
      console.error('[consumer] Malformed JSON — discarding:', rawContent.slice(0, 300));
      channel.ack(msg);
      return;
    }

    // Step 2: Validate schema — violations are unretriable, ACK and discard
    const parseResult = NotificationPayloadSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      console.error('[consumer] DTO validation failed — discarding:', formatZodError(parseResult.error));
      channel.ack(msg);
      return;
    }

    const payload = parseResult.data;
    console.log(
      `[consumer] Processing type=${payload.type} metadata=${JSON.stringify(payload.metadata)} for ${payload.recipientUserIds.length} user(s), ${payload.recipientFcmTokens.length} token(s)`
    );
    if (payload.recipientFcmTokens.length === 0) {
      console.warn(`[consumer] type=${payload.type} sin recipientFcmTokens — no se enviará push, solo se persistirá`);
    }

    // Step 3: Persist to PostgreSQL — infrastructure errors go to DLQ
    try {
      await persistFanOut(payload);
    } catch (err) {
      console.error(`[consumer] DB error for type=${payload.type}:`, err);
      channel.nack(msg, false, false);
      return;
    }

    // Step 4: Send FCM push notifications — transient errors go to DLQ
    // DB insert is idempotent so a retry from DLQ is safe
    try {
      await sendToRecipients(payload);
    } catch (err) {
      console.error(`[consumer] FCM error for type=${payload.type}:`, err);
      channel.nack(msg, false, false);
      return;
    }

    channel.ack(msg);
    console.log(`[consumer] type=${payload.type} processed successfully`);
  });
}
