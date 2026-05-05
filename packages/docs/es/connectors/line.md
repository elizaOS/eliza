---
title: Conector de LINE
sidebarTitle: LINE
description: Conecta tu agente a LINE usando el paquete @elizaos/plugin-line.
---

Conecta tu agente a LINE para mensajería de bots y conversaciones con clientes.

<div id="overview">

## Descripción general

</div>

El conector de LINE es un plugin de elizaOS que conecta tu agente a la API de mensajería de LINE. Soporta tipos de mensajes enriquecidos, chat grupal y manejo de eventos basado en webhooks. Este conector está disponible en el registro de plugins.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-line` |
| Clave de configuración | `connectors.line` |
| Instalación | `eliza plugins install @elizaos/plugin-line` |

<div id="setup-requirements">

## Requisitos de configuración

</div>

- Token de acceso de canal de LINE
- Secreto de canal de LINE
- Crea un canal de Messaging API en [developers.line.biz](https://developers.line.biz)

<div id="configuration">

## Configuración

</div>

```json
{
  "connectors": {
    "line": {
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
| `LINE_CHANNEL_ACCESS_TOKEN` | Token de acceso del canal desde la Consola de Desarrollador de LINE |
| `LINE_CHANNEL_SECRET` | Secreto del canal para verificación de webhooks |
| `LINE_CUSTOM_GREETING` | Mensaje de bienvenida personalizado para nuevos usuarios |

<div id="features">

## Características

</div>

- Mensajería de bots y conversaciones con clientes
- Tipos de mensajes enriquecidos (texto, sticker, imagen, video)
- Soporte de chat grupal
- Manejo de eventos basado en webhooks

<div id="related">

## Relacionado

</div>

- [Descripción general de conectores](/es/guides/connectors#line)
