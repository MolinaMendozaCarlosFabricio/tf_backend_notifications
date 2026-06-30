import { z } from 'zod';

export const NotificationPayloadSchema = z.object({
  recipientUserIds: z.array(z.string().uuid()).min(1),
  recipientFcmTokens: z.array(z.string().min(1)),
  title: z.string().max(150),
  body: z.string().min(1),
  type: z.string().max(50),
  screenRoute: z.string().max(150).nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
});

export type NotificationPayloadDTO = z.infer<typeof NotificationPayloadSchema>;
