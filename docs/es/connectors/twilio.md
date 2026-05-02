---
title: Conector de Twilio
sidebarTitle: Twilio
description: Conecta tu agente a Twilio para SMS y voz usando el paquete @elizaos/plugin-twilio.
---

Conecta tu agente a Twilio para mensajería SMS y capacidades de llamadas de voz.

<div id="overview">

## Descripción general

</div>

El conector de Twilio es un plugin de elizaOS que conecta tu agente a las APIs de comunicación de Twilio. Soporta SMS entrantes y salientes, así como capacidades de llamadas de voz. Este conector está disponible en el registro de plugins.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-twilio` |
| Clave de configuración | `connectors.twilio` |
| Instalación | `eliza plugins install @elizaos/plugin-twilio` |

<div id="setup-requirements">

## Requisitos de configuración

</div>

- Account SID y Auth Token de Twilio
- Un número de teléfono de Twilio

<div id="configuration">

## Configuración

</div>

```json
{
  "connectors": {
    "twilio": {
      "enabled": true
    }
  }
}
```

<div id="environment-variables">

## Variables de entorno

</div>

| Variable | Descripción |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Account SID de Twilio |
| `TWILIO_AUTH_TOKEN` | Auth Token de Twilio |
| `TWILIO_PHONE_NUMBER` | Número de teléfono de Twilio para envío/recepción |

<div id="features">

## Características

</div>

- Mensajería SMS (enviar y recibir)
- Capacidades de llamadas de voz
- Manejo de mensajes entrantes basado en webhooks

<div id="related">

## Relacionado

</div>

- [Descripción general de conectores](/es/guides/connectors#twilio)
