---
title: "Plugin de Zalo"
sidebarTitle: "Zalo"
description: "Conector de Zalo para Eliza — integración de bot con la plataforma de mensajería Zalo."
---

El plugin de Zalo conecta agentes de Eliza a Zalo, permitiendo el manejo de mensajes a través de la API de Cuenta Oficial de Zalo.

**Package:** `@elizaos/plugin-zalo`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-zalo
```

<div id="setup">

## Configuración

</div>

<div id="1-create-a-zalo-official-account">

### 1. Crea una Cuenta Oficial de Zalo

</div>

1. Ve al [portal de desarrolladores de Zalo](https://developers.zalo.me/)
2. Crea una aplicación y obtén tu App ID y App Secret
3. Genera un token de acceso y un token de actualización para acceso a la API

<div id="2-configure-eliza">

### 2. Configura Eliza

</div>

```json
{
  "connectors": {
    "zalo": {
      "accessToken": "YOUR_ACCESS_TOKEN",
      "refreshToken": "YOUR_REFRESH_TOKEN",
      "appId": "YOUR_APP_ID",
      "appSecret": "YOUR_APP_SECRET"
    }
  }
}
```

O mediante variables de entorno:

```bash
export ZALO_ACCESS_TOKEN=YOUR_ACCESS_TOKEN
export ZALO_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
export ZALO_APP_ID=YOUR_APP_ID
export ZALO_APP_SECRET=YOUR_APP_SECRET
```

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `accessToken` | Sí | Token de acceso de la API de Zalo |
| `refreshToken` | Sí | Token de actualización de la API de Zalo |
| `appId` | Sí | ID de la aplicación Zalo |
| `appSecret` | Sí | Secreto de la aplicación Zalo |
| `enabled` | No | Establecer `false` para deshabilitar (predeterminado: `true`) |

<div id="environment-variables">

## Variables de entorno

</div>

```bash
export ZALO_ACCESS_TOKEN=YOUR_ACCESS_TOKEN
export ZALO_REFRESH_TOKEN=YOUR_REFRESH_TOKEN
export ZALO_APP_ID=YOUR_APP_ID
export ZALO_APP_SECRET=YOUR_APP_SECRET
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
