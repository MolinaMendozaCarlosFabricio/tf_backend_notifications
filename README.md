# server-notifications

Worker de Node.js + TypeScript que consume mensajes de una cola RabbitMQ para enviar notificaciones push via Firebase Cloud Messaging (FCM) y persistir el historial en PostgreSQL.

## Requisitos previos

- Node.js >= 18
- RabbitMQ corriendo y accesible
- PostgreSQL con las tablas `notifications` y `user_notifications` creadas (ver [Esquema de base de datos](#esquema-de-base-de-datos))
- Proyecto de Firebase con una cuenta de servicio descargada

## Instalación

```bash
npm install
```

## Configuración

Copia el archivo de ejemplo y rellena los valores:

```bash
cp .env.example .env
```

| Variable | Descripción | Ejemplo |
|---|---|---|
| `NODE_ENV` | Entorno de ejecución | `development` |
| `PORT` | Puerto del servidor HTTP de health check | `3000` |
| `RABBITMQ_URL` | URL de conexión a RabbitMQ | `amqp://guest:guest@localhost:5672` |
| `DATABASE_URL` | URL de conexión a PostgreSQL | `postgres://user:pass@localhost:5432/dbname` |
| `FIREBASE_SERVICE_ACCOUNT` | JSON completo de la cuenta de servicio de Firebase (en una sola línea) | `{"type":"service_account",...}` |

> **Nota sobre `FIREBASE_SERVICE_ACCOUNT`**: descargá el archivo JSON desde la consola de Firebase (Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada) y pegá su contenido como string en una sola línea.

## Ejecución

### Modo desarrollo (hot-reload)

```bash
npm run dev
```

### Modo producción

```bash
npm run build
npm start
```

## Health checks

Una vez arrancado, el worker expone dos endpoints:

| Endpoint | Descripción |
|---|---|
| `GET /health` | Liveness probe — el proceso está vivo |
| `GET /ready` | Readiness probe — verifica conectividad con PostgreSQL |

```bash
curl http://localhost:3000/health
# { "status": "ok", "service": "server-notifications", "timestamp": "..." }

curl http://localhost:3000/ready
# { "status": "ready", "db": "connected" }
```

## Topología RabbitMQ

El worker aserta automáticamente la siguiente topología al arrancar. No es necesario crearla manualmente.

```
[ Exchange: notifications (direct) ]
        │ routing key: notification.push
        ▼
[ Queue: notification-push-queue ]
        │ NACK (error de infraestructura)
        ▼
[ Exchange: notifications.dlx (direct) ]
        │
        ▼
[ Queue: notification-push-dlq ] ── TTL 30s ──► vuelve a notifications
```

Para publicar un mensaje de prueba desde la UI de administración de RabbitMQ (`http://localhost:15672`):

- Exchange: `notifications`
- Routing key: `notification.push`
- Payload: ver [Formato del mensaje](#formato-del-mensaje)

## Formato del mensaje

El productor debe publicar con `Buffer.from(JSON.stringify(payload))` — el worker espera JSON.

```json
{
  "recipientUserIds": ["uuid-usuario-1", "uuid-usuario-2"],
  "recipientFcmTokens": ["fcm-token-1", "fcm-token-2"],
  "title": "Nuevo residuo cerca de ti",
  "body": "Se publicó Aluminio a 320m de tu local",
  "type": "WASTE_NEARBY",
  "screenRoute": "/post-detail",
  "metadata": {
    "postId": "uuid-publicacion"
  }
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `recipientUserIds` | `string[]` (UUIDs) | Sí | Usuarios que recibirán la notificación en su historial |
| `recipientFcmTokens` | `string[]` | Sí | Tokens FCM a los que se envía el push (puede ser vacío) |
| `title` | `string` (max 150) | Sí | Título de la notificación |
| `body` | `string` | Sí | Cuerpo del mensaje |
| `type` | `string` (max 50) | Sí | Tipo de evento (ej. `WASTE_NEARBY`) |
| `screenRoute` | `string` (max 150) | No | Ruta en la app Flutter que se abre al tocar la notificación |
| `metadata` | `object` | No | Datos adicionales para la app (se serializa como JSON string en FCM) |

## Esquema de base de datos

Ejecutá estas sentencias en tu instancia de PostgreSQL antes de arrancar el worker:

```sql
CREATE TABLE notifications (
    notification_id UUID PRIMARY KEY,
    title VARCHAR(150) NOT NULL,
    body TEXT NOT NULL,
    type VARCHAR(50) NOT NULL,
    route VARCHAR(100),
    screen_route VARCHAR(150),
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE user_notifications (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    notification_id UUID NOT NULL REFERENCES notifications(notification_id) ON DELETE CASCADE,
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    CONSTRAINT unique_user_notification UNIQUE (user_id, notification_id)
);
```

## Estrategia de reintentos

| Tipo de error | Acción |
|---|---|
| JSON malformado | ACK — se descarta (no tiene solución con reintento) |
| Payload inválido (DTO) | ACK — se descarta (el productor debe corregir el contrato) |
| Error de PostgreSQL | NACK → DLQ → reintento tras 30 segundos |
| Error transitorio de FCM | NACK → DLQ → reintento tras 30 segundos |
| Token FCM inválido/expirado | Se loggea y se continúa (no es un error de infraestructura) |
