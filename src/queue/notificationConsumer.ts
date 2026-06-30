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
      // Broker cancelled the consumer (e.g. queue deleted) — not a message error
      console.warn('[consumer] Consumer cancelled by broker');
      return;
    }

    const rawContent = msg.content.toString();

    // Step 1: Parse JSON — malformed JSON is unretriable, ACK and discard
    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(rawContent);
    } catch {
      console.error('[consumer] Malformed JSON — discarding:', rawContent.slice(0, 300));
      channel.ack(msg);
      return;
    }

    // Step 2: Validate schema — schema violations are unretriable, ACK and discard
    const parseResult = NotificationPayloadSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      console.error('[consumer] DTO validation failed — discarding:', formatZodError(parseResult.error));
      channel.ack(msg);
      return;
    }

    const payload = parseResult.data;
    console.log(
      `[consumer] Processing notificationId=${payload.notificationId} for ${payload.recipients.length} recipient(s)`
    );

    // Step 3: Persist to PostgreSQL (fan-out) — infrastructure errors go to DLQ
    try {
      await persistFanOut(payload);
    } catch (err) {
      console.error(`[consumer] DB error for notificationId=${payload.notificationId}:`, err);
      // requeue=false: do NOT put back in the main queue directly — let DLX/DLQ handle retry
      channel.nack(msg, false, false);
      return;
    }

    // Step 4: Send FCM push notifications — transient errors go to DLQ for retry
    // Note: DB insert is idempotent (ON CONFLICT DO NOTHING), so a retry is safe
    try {
      await sendToRecipients(payload);
    } catch (err) {
      console.error(`[consumer] FCM error for notificationId=${payload.notificationId}:`, err);
      channel.nack(msg, false, false);
      return;
    }

    // Step 5: All done — ACK
    channel.ack(msg);
    console.log(`[consumer] notificationId=${payload.notificationId} processed successfully`);
  });
}
