---
title: "Plugin de Bluesky"
sidebarTitle: "Bluesky"
description: "Conector de Bluesky para Eliza — publica, responde e interactúa en la red del Protocolo AT."
---

El plugin de Bluesky conecta agentes de Eliza a la red social Bluesky a través del Protocolo AT, permitiendo publicar, responder e interactuar socialmente.

**Package:** `@elizaos/plugin-bluesky`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-bluesky
```

<div id="setup">

## Configuración

</div>

<div id="1-get-your-bluesky-credentials">

### 1. Obtén tus credenciales de Bluesky

</div>

1. Ve a [bsky.app](https://bsky.app) y crea una cuenta (o usa una existente)
2. Anota tu handle (por ejemplo, `yourname.bsky.social`)
3. Usa tu nombre de usuario y contraseña de cuenta (o genera una contraseña de aplicación en Configuración → Contraseñas de App)

<div id="2-configure-eliza">

### 2. Configura Eliza

</div>

```json
{
  "connectors": {
    "bluesky": {
      "username": "YOUR_USERNAME",
      "password": "YOUR_PASSWORD",
      "handle": "YOUR_HANDLE"
    }
  }
}
```

O mediante variables de entorno:

```bash
export BLUESKY_USERNAME=YOUR_USERNAME
export BLUESKY_PASSWORD=YOUR_PASSWORD
export BLUESKY_HANDLE=YOUR_HANDLE
```

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `username` | Sí | Nombre de usuario de la cuenta de Bluesky |
| `password` | Sí | Contraseña de cuenta o contraseña de aplicación de Bluesky |
| `handle` | Sí | Handle de Bluesky (por ejemplo, `yourname.bsky.social`) |
| `enabled` | No | Establecer `false` para deshabilitar (predeterminado: `true`) |

<div id="environment-variables">

## Variables de entorno

</div>

```bash
export BLUESKY_USERNAME=YOUR_USERNAME
export BLUESKY_PASSWORD=YOUR_PASSWORD
export BLUESKY_HANDLE=YOUR_HANDLE
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
