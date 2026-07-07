import { randomUUID } from 'crypto';
import { pool } from '../config/database';
import { NotificationPayloadDTO } from '../dtos/notification.dto';

export async function persistFanOut(payload: NotificationPayloadDTO): Promise<void> {
  const client = await pool.connect();

  // IDs generated here since the producer no longer sends them
  const notificationId = randomUUID();

  console.log(`[persistFanOut] type=${payload.type} userIds=${JSON.stringify(payload.recipientUserIds)}`);

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO notifications (
         notification_id, title, body, type, screen_route, metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        notificationId,
        payload.title,
        payload.body,
        payload.type,
        payload.screenRoute ?? null,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
      ]
    );

    for (const userId of payload.recipientUserIds) {
      try {
        await client.query(
          `INSERT INTO user_notifications (id, user_id, notification_id)
           VALUES ($1, $2, $3)
           ON CONFLICT ON CONSTRAINT unique_user_notification DO NOTHING`,
          [randomUUID(), userId, notificationId],
        );
      } catch (err: any) {
        if (err.code === '23503') {
          console.warn(`[persistFanOut] user_id=${userId} no existe en users, omitiendo user_notifications row`);
          continue;
        }
        throw err;
      }
    }

    await client.query('COMMIT');
    console.log(`[persistFanOut] Fan-out committed: notificationId=${notificationId}, recipients=${payload.recipientUserIds.length}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
