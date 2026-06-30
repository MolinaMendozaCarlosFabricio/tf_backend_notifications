import 'dotenv/config';
import { env } from './config/env';
import { createApp } from './app';
import { pool, checkDbConnection } from './config/database';
import { createRabbitContext, RabbitContext } from './queue/rabbitClient';
import { startNotificationConsumer } from './queue/notificationConsumer';

async function bootstrap(): Promise<void> {
  console.log(`[bootstrap] Starting server-notifications in ${env.NODE_ENV} mode`);

  // 1. Verify DB connectivity at startup — fail fast before accepting any messages
  try {
    await checkDbConnection();
    console.log('[bootstrap] PostgreSQL connection verified');
  } catch (err) {
    console.error('[bootstrap] Cannot connect to PostgreSQL at startup:', err);
    process.exit(1);
  }

  // 2. Start HTTP server first so health checks pass during RabbitMQ connect
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[bootstrap] Health check server listening on port ${env.PORT}`);
  });

  // 3. Connect to RabbitMQ and assert topology
  let rabbitCtx: RabbitContext;
  try {
    rabbitCtx = await createRabbitContext();
    console.log('[bootstrap] RabbitMQ connection established');
  } catch (err) {
    console.error('[bootstrap] Cannot connect to RabbitMQ at startup:', err);
    process.exit(1);
  }

  // 4. Start consuming messages
  await startNotificationConsumer(rabbitCtx.channel);
  console.log('[bootstrap] Worker is ready — listening for notifications');

  // 5. Graceful shutdown on SIGTERM / SIGINT
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[bootstrap] Received ${signal} — shutting down gracefully`);
    try {
      await rabbitCtx.channel.close();
      await rabbitCtx.connection.close();
      await pool.end();
      server.close(() => {
        console.log('[bootstrap] HTTP server closed');
        process.exit(0);
      });
    } catch (err) {
      console.error('[bootstrap] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[bootstrap] Unhandled error during startup:', err);
  process.exit(1);
});
