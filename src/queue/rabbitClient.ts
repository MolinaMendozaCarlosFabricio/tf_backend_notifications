import amqplib, { Channel } from 'amqplib';
import type { ChannelModel } from 'amqplib';
import { env } from '../config/env';

export const EXCHANGES = {
  MAIN: 'notifications',
  DLX: 'notifications.dlx',
} as const;

export const QUEUES = {
  MAIN: 'notification-push-queue',
  DLQ: 'notification-push-dlq',
} as const;

export const ROUTING_KEYS = {
  PUSH: 'notification.push',
} as const;

// Time a failed message sits in the DLQ before being re-queued to the main queue
const DLQ_TTL_MS = 30_000;

async function assertTopology(channel: Channel): Promise<void> {
  // 1. Main exchange — direct type so binding is explicit by routing key
  await channel.assertExchange(EXCHANGES.MAIN, 'direct', { durable: true });

  // 2. DLX exchange — receives NACKed messages from the main queue
  await channel.assertExchange(EXCHANGES.DLX, 'direct', { durable: true });

  // 3. Main queue — NACKed messages go to DLX with the same routing key
  await channel.assertQueue(QUEUES.MAIN, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGES.DLX,
      'x-dead-letter-routing-key': ROUTING_KEYS.PUSH,
    },
  });

  // 4. DLQ — messages wait here for TTL, then dead-letter back to the main exchange
  await channel.assertQueue(QUEUES.DLQ, {
    durable: true,
    arguments: {
      'x-message-ttl': DLQ_TTL_MS,
      'x-dead-letter-exchange': EXCHANGES.MAIN,
      'x-dead-letter-routing-key': ROUTING_KEYS.PUSH,
    },
  });

  await channel.bindQueue(QUEUES.MAIN, EXCHANGES.MAIN, ROUTING_KEYS.PUSH);
  await channel.bindQueue(QUEUES.DLQ, EXCHANGES.DLX, ROUTING_KEYS.PUSH);

  console.log('[rabbit] Topology asserted');
}

export interface RabbitContext {
  connection: ChannelModel;
  channel: Channel;
}

export async function createRabbitContext(): Promise<RabbitContext> {
  const connection = await amqplib.connect(env.RABBITMQ_URL);

  // On connection drop, exit and let the process manager (Docker/K8s) restart
  connection.on('error', (err: Error) => {
    console.error('[rabbit] Connection error:', err.message);
    process.exit(1);
  });

  connection.on('close', () => {
    console.error('[rabbit] Connection closed unexpectedly');
    process.exit(1);
  });

  const channel = await connection.createChannel();

  // prefetch(1): only hold one unacked message at a time — critical for message safety
  await channel.prefetch(1);

  await assertTopology(channel);

  return { connection, channel };
}
