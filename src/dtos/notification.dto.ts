import { z } from 'zod';

export const RecipientSchema = z.object({
  userId: z.string().uuid(),
  userNotificationId: z.string().uuid(),
  deviceTokens: z.array(z.string().min(1)),
});

export const NotificationPayloadSchema = z.object({
  notificationId: z.string().uuid(),
  title: z.string().max(150),
  body: z.string().min(1),
  type: z.string().max(50),
  route: z.string().max(100).nullable().optional(),
  screenRoute: z.string().max(150).nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
  recipients: z.array(RecipientSchema).min(1),
});

export type NotificationPayloadDTO = z.infer<typeof NotificationPayloadSchema>;
export type RecipientDTO = z.infer<typeof RecipientSchema>;
