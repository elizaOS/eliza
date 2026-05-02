---
title: "Plugin de Twilio"
sidebarTitle: "Twilio"
description: "Conector de Twilio para Eliza — integración de SMS y voz a través de la API de Twilio."
---

El plugin de Twilio conecta agentes de Eliza a Twilio, permitiendo mensajería SMS e interacciones de voz a través de números de teléfono de Twilio.

**Package:** `@elizaos/plugin-twilio`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-twilio
```

<div id="setup">

## Configuración

</div>

<div id="1-get-your-twilio-credentials">

### 1. Obtén tus credenciales de Twilio

</div>

1. Regístrate en [twilio.com](https://www.twilio.com/)
2. Desde el panel de la Consola de Twilio, copia tu **Account SID** y **Auth Token**
3. Compra o configura un número de teléfono de Twilio

<div id="2-configure-eliza">

### 2. Configura Eliza

</div>

```json
{
  "connectors": {
    "twilio": {
      "accountSid": "YOUR_ACCOUNT_SID",
      "authToken": "YOUR_AUTH_TOKEN",
      "phoneNumber": "YOUR_PHONE_NUMBER"
    }
  }
}
```

O mediante variables de entorno:

```bash
export TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
export TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
export TWILIO_PHONE_NUMBER=YOUR_PHONE_NUMBER
```

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `accountSid` | Sí | Account SID de Twilio |
| `authToken` | Sí | Auth Token de Twilio |
| `phoneNumber` | Sí | Número de teléfono de Twilio (formato E.164) |
| `enabled` | No | Establecer `false` para deshabilitar (predeterminado: `true`) |

<div id="environment-variables">

## Variables de entorno

</div>

```bash
export TWILIO_ACCOUNT_SID=YOUR_ACCOUNT_SID
export TWILIO_AUTH_TOKEN=YOUR_AUTH_TOKEN
export TWILIO_PHONE_NUMBER=YOUR_PHONE_NUMBER
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
