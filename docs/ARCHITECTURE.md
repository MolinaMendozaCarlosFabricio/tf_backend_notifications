# 🚀 Worker Consumidor de Notificaciones Push

Este proyecto es un microservicio especializado (Worker) desarrollado en **Node.js**, **TypeScript** y **Express**. Su único propósito es actuar como un consumidor de infraestructura dentro de nuestra arquitectura orientada a eventos, procesando los mensajes de una cola de RabbitMQ para persistir el historial de notificaciones en **PostgreSQL** y despachar notificaciones push a través de **Firebase Cloud Messaging (FCM)**.

---

## 📌 Contexto y Flujo de la Arquitectura

Para evitar bloquear la API principal (NestJS) con peticiones I/O hacia bases de datos de historial o llamadas HTTP externas al SDK de Firebase, delegamos el flujo de manera asíncrona:

```text
[ API Principal (NestJS) ] 
       │
       ▼ (Publica evento con Payload + Tokens)
[ Exchange de Notificaciones (RabbitMQ) ]
       │
       ▼ (Enruta por Routing Key)
[ Cola: notification-push-queue ]
       │
       ▼ (Escucha de forma activa)
[ Este Worker (Consumidor TS) ] ───► [ Guarda en PostgreSQL ] (Tablas Relacionales)
       │
       └───────────────────────────► [ Firebase Cloud Messaging ] (Data Messages)
                                                   │
                                                   ▼
                                         [ App Móvil (Flutter) ]

```

---

## 🛠️ Estrategia FCM: Data-Only Notifications

Para este proyecto hemos optado por utilizar **Data Notifications** (mensajes de datos puros) en lugar de *Notification Messages* estándar de FCM.

### ¿Por qué?

Las notificaciones de notificación estándar son controladas automáticamente por el sistema operativo del dispositivo. Sin embargo, las **Data Notifications** le dan el control total a nuestra aplicación en **Flutter**:

1. **Procesamiento en Segundo Plano:** Flutter recibe el payload silenciosamente en background/terminated state.
2. **Enrutamiento Dinámico:** La app lee los campos `screen_route` y `metadata` para decidir exactamente qué pantalla abrir antes de mostrar visualmente la alerta.
3. **Personalización total:** Permite generar notificaciones locales personalizadas (usando paquetes como `flutter_local_notifications`) asegurando que el diseño y comportamiento sean idénticos en Android e iOS.

---

## 🛡️ Estrategia de Resiliencia y Reintentos (DLQ)

Dado que este componente interactúa con servicios externos (FCM) y de almacenamiento (PostgreSQL), implementamos un sistema de tolerancia a fallos basado en **Dead Letter Exchanges (DLX)**:

1. **Errores de Validación (Payload Corrupto):** Si el DTO invalida el mensaje, se hace un `ACK` inmediato y el mensaje se descarta (o se envía a una cola de auditoría) ya que reintentarlo no cambiará su estructura.
2. **Errores de Infraestructura (FCM 500 / DB Down):** Si Firebase o PostgreSQL fallan temporalmente, el consumidor envía un `NACK` indicándole a RabbitMQ que envíe el mensaje a una **DLQ (Dead Letter Queue)** con un tiempo de vida (TTL). Una vez expira el TTL, el mensaje vuelve a la cola principal para ser reintentado de forma segura sin saturar el sistema en bucles infinitos.

---

## 📂 Estructura de Carpetas del Proyecto

La arquitectura se mantiene plana y orientada exclusivamente a la capa de **infraestructura**, abstrayendo los contratos mediante DTOs validados en tiempo de ejecución.

```text
notification-consumer/
├── src/
│   ├── config/                  # Inicialización de clientes y variables de entorno
│   │   ├── database.ts          # Pool de conexión a PostgreSQL (pg / Kysely / Prisma)
│   │   ├── env.ts               # Validación de variables de entorno (Zod)
│   │   └── firebase.ts          # Inicialización de Firebase Admin SDK
│   │
│   ├── dtos/                    # Contratos de datos de entrada (Desacoplamiento)
│   │   └── notification.dto.ts  # Esquema Zod y Tipo TS para el payload de la cola
│   │
│   ├── models/                  # Representación de las tablas de la Base de Datos
│   │   └── notification.model.ts# Interfaces/Modelos para PostgreSQL
│   │
│   ├── queue/                   # Capa de mensajería (RabbitMQ)
│   │   ├── rabbitClient.ts      # Conexión, canales y aserción de colas/exchanges
│   │   └── notificationConsumer.ts # Escucha de la cola y orquestación del flujo
│   │
│   ├── services/                # Proveedores de Infraestructura (Casos de uso puros)
│   │   ├── fcm.service.ts       # Lógica para estructurar y enviar el Data Message a FCM
│   │   └── notification.service.ts # Lógica para hacer inserts en Postgres (Fan-Out)
│   │
│   ├── app.ts                   # Instancia Express (Exclusivo para endpoints de Health Check)
│   └── index.ts                 # Bootstrap del sistema (Punto de entrada)
│
├── .env.example
├── package.json
└── tsconfig.json

```

---

## 📦 Especificación del Contrato de Datos (DTO)

El payload transmitido por RabbitMQ consolida toda la información de la notificación y los destinatarios en una sola operación atómica.

### Ejemplo de Payload (JSON)

```json
{
  "notificationId": "a3b9d2e1-c4f5-4a6b-8c7d-9e0f1a2b3c4d",
  "title": "¡Nueva oferta recibida!",
  "body": "Has recibido una oferta de $150 en tu publicación.",
  "type": "OFFER_RECEIVED",
  "route": "/offers/123",
  "screenRoute": "/collection-details",
  "metadata": {
    "offerId": "7b8c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e"
  },
  "recipients": [
    {
      "userId": "e4f5a6b7-c8d9-0e1f-2a3b-4c5d6e7f8a9b",
      "userNotificationId": "f8a9b0c1-d2e3-4f5a-6b7c-8d9e0f1a2b3c",
      "deviceTokens": [
        "fcm_token_user1_device1_hash...",
        "fcm_token_user1_device2_hash..."
      ]
    }
  ]
}

```

### Implementación del DTO (`src/dtos/notification.dto.ts`)

Utilizamos **Zod** para asegurar que cualquier discrepancia entre el payload emitido por NestJS y lo esperado por este Worker sea atajada en la frontera del sistema:

```typescript
import { z } from 'zod';

export const NotificationPayloadSchema = z.object({
  notificationId: z.string().uuid(),
  title: z.string().max(150),
  body: z.string(),
  type: z.string().max(50),
  route: z.string().max(100).nullable().optional(),
  screenRoute: z.string().max(150).nullable().optional(),
  metadata: z.record(z.any()).nullable().optional(),
  recipients: z.array(
    z.object({
      userId: z.string().uuid(),
      userNotificationId: z.string().uuid(),
      deviceTokens: z.array(z.string())
    })
  ).min(1)
});

export type NotificationPayloadDTO = z.infer<typeof NotificationPayloadSchema>;

```

---

## 🗄️ Esquema de Base de Datos (PostgreSQL)

El almacenamiento ejecuta el patrón **Fan-Out** mediante dos tablas clave, optimizando el espacio al no duplicar el contenido del mensaje cuando va dirigido a múltiples usuarios.

```sql
-- Tabla base de la notificación física
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

-- Tabla pivote que mapea la notificación con cada usuario destino (Fan-Out)
CREATE TABLE user_notifications (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    notification_id UUID NOT NULL REFERENCES notifications(notification_id) ON DELETE CASCADE,
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    CONSTRAINT unique_user_notification UNIQUE (user_id, notification_id)
);

```