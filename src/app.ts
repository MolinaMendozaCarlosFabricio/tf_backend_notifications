import express, { Request, Response } from 'express';
import { checkDbConnection } from './config/database';

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  // Liveness probe — is the process alive?
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'server-notifications',
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness probe — can the worker handle messages? (checks DB connectivity)
  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      await checkDbConnection();
      res.json({ status: 'ready', db: 'connected' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(503).json({ status: 'not_ready', db: 'disconnected', error: message });
    }
  });

  return app;
}
