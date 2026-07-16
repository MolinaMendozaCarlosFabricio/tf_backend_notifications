import { messaging } from '../config/firebase';
import { NotificationPayloadDTO } from '../dtos/notification.dto';

interface FcmDataPayload {
  [key: string]: string;
  title: string;
  body: string;
  type: string;
  screenRoute: string;
  metadata: string;
}

function buildDataPayload(payload: NotificationPayloadDTO): FcmDataPayload {
  return {
    title: payload.title,
    body: payload.body,
    type: payload.type,
    screenRoute: payload.screenRoute ?? '',
    metadata: payload.metadata ? JSON.stringify(payload.metadata) : '{}',
  };
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

export async function sendToRecipients(payload: NotificationPayloadDTO): Promise<void> {
  if (payload.recipientFcmTokens.length === 0) {
    console.warn('[fcm.service] No FCM tokens provided — skipping send');
    return;
  }

  const data = buildDataPayload(payload);

  const response = await messaging.sendEachForMulticast({
    tokens: payload.recipientFcmTokens,
    data,
    android: { priority: 'high', ttl: 3600 },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'background',
      },
      payload: {
        aps: { 'content-available': 1 },
      },
    },
  });

  const invalidTokens: string[] = [];

  response.responses.forEach((resp, index) => {
    if (resp.success) return;

    const code = resp.error?.code ?? 'unknown';
    const token = payload.recipientFcmTokens[index];

    if (INVALID_TOKEN_CODES.has(code)) {
      console.warn(`[fcm.service] Invalid/expired token: ${token} (${code})`);
      invalidTokens.push(token);
    } else {
      throw new Error(
        `[fcm.service] Transient FCM error on token ${token}: ${code} — ${resp.error?.message ?? ''}`
      );
    }
  });

  if (invalidTokens.length > 0) {
    console.warn(`[fcm.service] ${invalidTokens.length} invalid token(s) — consider cleaning them up`);
  }

  console.log(
    `[fcm.service] Sent to ${response.successCount}/${payload.recipientFcmTokens.length} tokens`
  );
}
