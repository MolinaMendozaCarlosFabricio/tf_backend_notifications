import * as admin from 'firebase-admin';
import { env } from './env';

function initFirebase(): admin.messaging.Messaging {
  if (admin.apps.length > 0) {
    return admin.app().messaging();
  }

  let serviceAccount: admin.ServiceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as admin.ServiceAccount;
  } catch {
    console.error('[firebase] FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log('[firebase] Admin SDK initialized');
  return admin.app().messaging();
}

export const messaging = initFirebase();
