import { pool } from '../config/database';
import { NotificationPayloadDTO } from '../dtos/notification.dto';

export async function persistFanOut(payload: NotificationPayloadDTO): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Insert notification content once — idempotent on retry via ON CONFLICT DO NOTHING
    await client.query(
      `INSERT INTO notifications (
         notification_id, title, body, type, route, screen_route, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (notification_id) DO NOTHING`,
      [
        payload.notificationId,
        payload.title,
        payload.body,
        payload.type,
        payload.route ?? null,
        payload.screenRoute ?? null,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
      ]
    );

    // Fan-out: one row per recipient — userNotificationId comes from the producer (stable across retries)
    for (const recipient of payload.recipients) {
      await client.query(
        `INSERT INTO user_notifications (id, user_id, notification_id)
         VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT unique_user_notification DO NOTHING`,
        [recipient.userNotificationId, recipient.userId, payload.notificationId]
      );
    }

    await client.query('COMMIT');
    console.log(
      `[notification.service] Fan-out committed: notificationId=${payload.notificationId}, recipients=${payload.recipients.length}`
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
