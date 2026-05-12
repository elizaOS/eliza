---
title: Conector de Nextcloud Talk
sidebarTitle: Nextcloud Talk
description: Conecta tu agente a Nextcloud Talk usando el paquete @elizaos/plugin-nextcloud-talk.
---

Conecta tu agente a Nextcloud Talk para mensajería de colaboración autoalojada.

<div id="overview">

## Descripción general

</div>

El conector de Nextcloud Talk es un plugin de elizaOS que conecta tu agente a las salas de Nextcloud Talk. Soporta conversaciones de mensajes directos y grupales en instancias autoalojadas de Nextcloud. Este conector está disponible en el registro de plugins.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-nextcloud-talk` |
| Clave de configuración | `connectors.nextcloud-talk` |
| Instalación | `eliza plugins install @elizaos/plugin-nextcloud-talk` |

<div id="setup-requirements">

## Requisitos de configuración

</div>

- Una instancia de Nextcloud con la app Talk habilitada
- Un secreto de bot para autenticación de webhooks (configurado en los ajustes de administración de Nextcloud Talk)
- Una URL públicamente accesible para el endpoint del webhook

<div id="configuration">

## Configuración

</div>

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  }
}
```

<div id="environment-variables">

## Variables de entorno

</div>

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `NEXTCLOUD_URL` | Sí | URL base de tu instancia Nextcloud (ej. `https://cloud.example.com`) |
| `NEXTCLOUD_BOT_SECRET` | Sí | Secreto del bot para verificación de firma del webhook |
| `NEXTCLOUD_WEBHOOK_HOST` | No | Dirección del host para el listener del webhook |
| `NEXTCLOUD_WEBHOOK_PORT` | No | Puerto para el listener del webhook |
| `NEXTCLOUD_WEBHOOK_PATH` | No | Ruta para el endpoint del webhook |
| `NEXTCLOUD_WEBHOOK_PUBLIC_URL` | No | URL pública completa del webhook (sobreescribe host/port/path) |
| `NEXTCLOUD_ALLOWED_ROOMS` | No | Lista de IDs de salas/canales separadas por coma |
| `NEXTCLOUD_ENABLED` | No | Establecer a `true` para habilitar (alternativa a config) |

```json
{
  "connectors": {
    "nextcloud-talk": {
      "enabled": true
    }
  },
  "env": {
    "NEXTCLOUD_URL": "https://cloud.example.com",
    "NEXTCLOUD_BOT_SECRET": "YOUR_BOT_SECRET",
    "NEXTCLOUD_WEBHOOK_PUBLIC_URL": "https://your-agent.example.com/hooks/nextcloud",
    "NEXTCLOUD_ALLOWED_ROOMS": "general,support"
  }
}
```

<div id="features">

## Características

</div>

- Mensajería basada en salas de Talk
- Soporte de conversaciones directas y grupales
- Entrega de mensajes basada en webhooks con verificación de firma
- Lista de permitidos por sala para controlar en qué conversaciones participa el agente
- Autoalojado — todos los datos permanecen en tu instancia Nextcloud

<div id="related">

## Relacionado

</div>

- [Descripción general de conectores](/es/guides/connectors#nextcloud-talk)
