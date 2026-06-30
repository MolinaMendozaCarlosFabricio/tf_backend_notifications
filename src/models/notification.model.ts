export interface NotificationRow {
  notification_id: string;
  title: string;
  body: string;
  type: string;
  route: string | null;
  screen_route: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface UserNotificationRow {
  id: string;
  user_id: string;
  notification_id: string;
  is_read: boolean;
  read_at: Date | null;
}
