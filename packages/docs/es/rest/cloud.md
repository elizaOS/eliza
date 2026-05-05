---
title: "API de la Nube"
sidebarTitle: "Cloud"
description: "Endpoints de la API REST para autenticación, estado de conexión, saldo de créditos y gestión de agentes en Eliza Cloud."
---

La API de la nube conecta el agente local Eliza a Eliza Cloud para inferencia alojada en la nube, créditos y gestión remota de agentes. El inicio de sesión utiliza un flujo estilo OAuth basado en navegador con sondeo para la finalización de la sesión.

Se espera que la facturación permanezca dentro de la aplicación siempre que Eliza Cloud exponga los endpoints de facturación necesarios. Los valores de `topUpUrl` devueltos por `/api/cloud/status` y `/api/cloud/credits` deben tratarse como un respaldo alojado, no como la experiencia de usuario principal.

<div id="endpoints">

## Endpoints

</div>

<div id="post-apicloudlogin">

### POST /api/cloud/login

</div>

Inicia el flujo de inicio de sesión de Eliza Cloud. Crea una sesión en la nube y devuelve una URL de navegador para que el usuario se autentique. Sondee `GET /api/cloud/login/status` con el `sessionId` devuelto para verificar la finalización.

**Respuesta**

```json
{
  "ok": true,
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "browserUrl": "https://www.elizacloud.ai/auth/cli-login?session=550e8400-e29b-41d4-a716-446655440000"
}
```

---

<div id="get-apicloudloginstatus">

### GET /api/cloud/login/status

</div>

Sondea el estado de una sesión de inicio de sesión. Cuando el estado es `"authenticated"`, la clave API se guarda automáticamente en la configuración y se aplica al entorno del proceso.

Cuando la función de wallet cloud está habilitada (`ENABLE_CLOUD_WALLET=1`), un inicio de sesión exitoso también desencadena el aprovisionamiento de wallet cloud de mejor esfuerzo. El agente intenta importar wallets EVM y Solana desde Eliza Cloud y establecerlas como la fuente de wallet principal. Si el aprovisionamiento falla, el inicio de sesión sigue siendo exitoso — la clave API se guarda, y el fallo del aprovisionamiento de wallet se registra sin afectar la respuesta de autenticación. Puede reintentar manualmente el aprovisionamiento de wallet más tarde usando `POST /api/wallet/refresh-cloud`.

**Parámetros de consulta**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `sessionId` | string | Sí | ID de sesión devuelto por `POST /api/cloud/login` |

**Respuesta (pending)**

```json
{
  "status": "pending"
}
```

**Respuesta (authenticated)**

```json
{
  "status": "authenticated",
  "keyPrefix": "eca-..."
}
```

**Valores de estado posibles**

| Estado | Descripción |
|--------|-------------|
| `"pending"` | El usuario aún no ha completado la autenticación |
| `"authenticated"` | Inicio de sesión exitoso — la clave API ha sido guardada |
| `"expired"` | La sesión expiró o no fue encontrada |
| `"error"` | Ocurrió un error al comunicarse con Eliza Cloud |

---

<div id="get-apicloudstatus">

### GET /api/cloud/status

</div>

Obtiene el estado de conexión a la nube, el estado de autenticación y la URL de facturación.

**Respuesta (conectado)**

```json
{
  "connected": true,
  "enabled": true,
  "cloudVoiceProxyAvailable": true,
  "hasApiKey": true,
  "userId": "user-123",
  "organizationId": "org-456",
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

**Respuesta (no conectado)**

```json
{
  "connected": false,
  "enabled": false,
  "cloudVoiceProxyAvailable": false,
  "hasApiKey": false,
  "reason": "not_authenticated"
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `connected` | boolean | Si el servicio de autenticación en la nube está autenticado |
| `enabled` | boolean | Si el modo nube está habilitado en la configuración |
| `cloudVoiceProxyAvailable` | boolean | Si el proxy de voz en la nube está disponible para la sesión actual |
| `hasApiKey` | boolean | Si una clave API está presente en la configuración |
| `userId` | string | ID de usuario autenticado (cuando está conectado) |
| `organizationId` | string | ID de organización autenticada (cuando está conectado) |
| `topUpUrl` | string | URL a la página de facturación en la nube |
| `reason` | string | Razón del estado desconectado |

---

<div id="get-apicloudcredits">

### GET /api/cloud/credits

</div>

Obtiene el saldo de créditos en la nube. Devuelve un saldo `null` cuando no está conectado.

**Respuesta**

```json
{
  "connected": true,
  "balance": 15.50,
  "low": false,
  "critical": false,
  "authRejected": false,
  "topUpUrl": "https://elizacloud.ai/dashboard/settings?tab=billing"
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `balance` | number \| null | Saldo de créditos en dólares |
| `low` | boolean | `true` cuando el saldo está por debajo de $2.00 |
| `critical` | boolean | `true` cuando el saldo está por debajo de $0.50 |
| `authRejected` | boolean | `true` cuando la clave API de la nube fue rechazada durante la verificación de créditos |

---

<div id="billing-proxy-endpoints">

### Endpoints proxy de facturación

</div>

Estos endpoints actúan como proxy de las APIs de facturación autenticadas de Eliza Cloud a través del backend local de Eliza para que la aplicación de escritorio pueda mantener la facturación, los métodos de pago y las recargas dentro de la aplicación. Requieren un inicio de sesión activo en Eliza Cloud porque el servidor local reenvía la clave API de la nube guardada.

Use `topUpUrl` solo como un respaldo alojado si Eliza Cloud no devuelve un flujo de pago integrado o una cotización crypto que la aplicación pueda renderizar directamente.

<div id="get-apicloudbillingsummary">

#### GET /api/cloud/billing/summary

</div>

Obtiene el resumen de facturación actual de Eliza Cloud.

**Respuesta típica**

```json
{
  "balance": 15.5,
  "currency": "USD",
  "embeddedCheckoutEnabled": false,
  "hostedCheckoutEnabled": true,
  "cryptoEnabled": true
}
```

<div id="get-apicloudbillingpayment-methods">

#### GET /api/cloud/billing/payment-methods

</div>

Lista los métodos de pago guardados para la cuenta autenticada de Eliza Cloud.

<div id="get-apicloudbillinghistory">

#### GET /api/cloud/billing/history

</div>

Lista la actividad de facturación reciente, incluyendo recargas e historial de liquidaciones.

<div id="post-apicloudbillingcheckout">

#### POST /api/cloud/billing/checkout

</div>

Crea una sesión de pago de facturación.

**Solicitud**

```json
{
  "amountUsd": 25,
  "mode": "hosted"
}
```

**Respuesta típica**

```json
{
  "provider": "stripe",
  "mode": "hosted",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_xxx...",
  "sessionId": "cs_xxx..."
}
```

Eliza prefiere el pago integrado cuando Eliza Cloud lo soporta, pero la integración actual de facturación en la nube aún puede devolver una URL de pago alojada.

<div id="post-apicloudbillingcryptoquote">

#### POST /api/cloud/billing/crypto/quote

</div>

Solicita una factura o cotización crypto para una recarga de créditos.

**Solicitud**

```json
{
  "amountUsd": 25,
  "walletAddress": "0xabc123..."
}
```

**Respuesta típica**

```json
{
  "provider": "oxapay",
  "network": "BEP20",
  "currency": "USDC",
  "amount": "25.000",
  "amountUsd": 25,
  "paymentLinkUrl": "https://pay.example.com/track_123",
  "expiresAt": "2026-03-15T01:00:00.000Z"
}
```

---

<div id="post-apiclouddisconnect">

### POST /api/cloud/disconnect

</div>

Desconecta de Eliza Cloud. Elimina la clave API de la configuración, el entorno del proceso y el registro de la base de datos del agente.

**Respuesta**

```json
{
  "ok": true,
  "status": "disconnected"
}
```

---

<div id="get-apicloudagents">

### GET /api/cloud/agents

</div>

Lista los agentes en la nube. Requiere una conexión activa a la nube.

**Respuesta**

```json
{
  "ok": true,
  "agents": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "My Cloud Agent",
      "status": "running",
      "createdAt": "2024-06-10T12:00:00Z"
    }
  ]
}
```

---

<div id="post-apicloudagents">

### POST /api/cloud/agents

</div>

Crea un nuevo agente en la nube. Requiere una conexión activa a la nube.

**Solicitud**

```json
{
  "agentName": "My Cloud Agent",
  "agentConfig": { "character": "eliza" },
  "environmentVars": { "OPENAI_API_KEY": "<OPENAI_API_KEY>" }
}
```

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `agentName` | string | Sí | Nombre para mostrar del agente en la nube |
| `agentConfig` | object | No | Objeto de configuración del agente |
| `environmentVars` | object | No | Variables de entorno a establecer en el agente en la nube |

**Respuesta (201 Created)**

```json
{
  "ok": true,
  "agent": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "My Cloud Agent",
    "status": "provisioning"
  }
}
```

---

<div id="post-apicloudagentsidprovision">

### POST /api/cloud/agents/:id/provision

</div>

Aprovisiona un agente en la nube — conecta el agente local a la instancia del agente en la nube.

**Parámetros de ruta**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `id` | UUID | Sí | ID del agente en la nube |

**Respuesta**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "My Cloud Agent",
  "status": { "connected": true }
}
```

---

<div id="post-apicloudagentsidshutdown">

### POST /api/cloud/agents/:id/shutdown

</div>

Apaga y elimina un agente en la nube.

**Parámetros de ruta**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `id` | UUID | Sí | ID del agente en la nube |

**Respuesta**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "stopped"
}
```

---

<div id="post-apicloudagentsidconnect">

### POST /api/cloud/agents/:id/connect

</div>

Conecta a un agente en la nube existente (desconectándose primero de cualquier agente activo actualmente).

**Parámetros de ruta**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `id` | UUID | Sí | ID del agente en la nube |

**Respuesta**

```json
{
  "ok": true,
  "agentId": "550e8400-e29b-41d4-a716-446655440000",
  "agentName": "My Cloud Agent",
  "status": { "connected": true }
}
```
