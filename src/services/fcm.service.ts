import { messaging } from '../config/firebase';
import { NotificationPayloadDTO } from '../dtos/notification.dto';

// FCM data values must all be strings, and the object must satisfy { [key: string]: string }
interface FcmDataPayload {
  [key: string]: string;
  notificationId: string;
  title: string;
  body: string;
  type: string;
  route: string;
  screenRoute: string;
  metadata: string;
}

function buildDataPayload(payload: NotificationPayloadDTO): FcmDataPayload {
  return {
    notificationId: payload.notificationId,
    title: payload.title,
    body: payload.body,
    type: payload.type,
    route: payload.route ?? '',
    screenRoute: payload.screenRoute ?? '',
    metadata: payload.metadata ? JSON.stringify(payload.metadata) : '{}',
  };
}

// These codes signal a permanently invalid/unregistered token — not a transient error.
// Throwing on these would cause an infinite NACK/retry loop with the same bad token.
const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

export async function sendToRecipients(payload: NotificationPayloadDTO): Promise<void> {
  const data = buildDataPayload(payload);

  for (const recipient of payload.recipients) {
    if (recipient.deviceTokens.length === 0) {
      console.warn(`[fcm.service] Recipient ${recipient.userId} has no device tokens — skipping`);
      continue;
    }

    // sendEachForMulticast is the v12+ replacement for the deprecated sendMulticast
    const response = await messaging.sendEachForMulticast({
      tokens: recipient.deviceTokens,
      data,
      android: {
        priority: 'high',
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'background',
        },
        payload: {
          aps: {
            'content-available': 1,
          },
        },
      },
    });

    const invalidTokens: string[] = [];

    response.responses.forEach((resp, index) => {
      if (resp.success) return;

      const code = resp.error?.code ?? 'unknown';
      const token = recipient.deviceTokens[index];

      if (INVALID_TOKEN_CODES.has(code)) {
        console.warn(
          `[fcm.service] Invalid/expired token for userId=${recipient.userId}: token=${token} (${code})`
        );
        invalidTokens.push(token);
      } else {
        // Transient error (quota, server error, network) — throw to trigger NACK and DLQ retry
        throw new Error(
          `[fcm.service] Transient FCM error for userId=${recipient.userId}: ${code} — ${resp.error?.message ?? ''}`
        );
      }
    });

    if (invalidTokens.length > 0) {
      console.warn(
        `[fcm.service] ${invalidTokens.length} invalid token(s) for userId=${recipient.userId} — consider cleaning them up`
      );
    }
  }
}
