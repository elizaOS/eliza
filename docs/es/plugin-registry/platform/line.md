---
title: "Plugin de LINE"
sidebarTitle: "LINE"
description: "Conector de LINE para Eliza — integración de bot con la plataforma de mensajería LINE."
---

El plugin de LINE conecta agentes de Eliza a LINE como un bot, permitiendo el manejo de mensajes en chats y grupos.

**Package:** `@elizaos/plugin-line`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-line
```

<div id="setup">

## Configuración

</div>

<div id="1-create-a-line-messaging-api-channel">

### 1. Crea un canal de LINE Messaging API

</div>

1. Ve a [LINE Developers Console](https://developers.line.biz/console/)
2. Crea un nuevo proveedor (o usa uno existente)
3. Crea un nuevo canal de **Messaging API**
4. En la pestaña **Messaging API**, emite un **Channel access token**
5. Anota el **Channel secret** de la pestaña **Basic settings**

<div id="2-configure-eliza">

### 2. Configura Eliza

</div>

```json
{
  "connectors": {
    "line": {
      "channelAccessToken": "YOUR_CHANNEL_ACCESS_TOKEN",
      "channelSecret": "YOUR_CHANNEL_SECRET"
    }
  }
}
```

O mediante variables de entorno:

```bash
export LINE_CHANNEL_ACCESS_TOKEN=YOUR_CHANNEL_ACCESS_TOKEN
export LINE_CHANNEL_SECRET=YOUR_CHANNEL_SECRET
```

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `channelAccessToken` | Sí | Token de acceso del canal de LINE Messaging API |
| `channelSecret` | Sí | Secreto del canal de LINE |
| `enabled` | No | Establecer `false` para deshabilitar (predeterminado: `true`) |

<div id="environment-variables">

## Variables de entorno

</div>

```bash
export LINE_CHANNEL_ACCESS_TOKEN=YOUR_CHANNEL_ACCESS_TOKEN
export LINE_CHANNEL_SECRET=YOUR_CHANNEL_SECRET
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
