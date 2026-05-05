---
title: Conector de Bluesky
sidebarTitle: Bluesky
description: Conecta tu agente a Bluesky usando el paquete @elizaos/plugin-bluesky.
---

Conecta tu agente a Bluesky para publicaciones sociales e interacción en la red del Protocolo AT.

<div id="overview">

## Descripción general

</div>

El conector de Bluesky es un plugin de elizaOS que conecta tu agente a Bluesky a través del Protocolo AT. Soporta publicación automatizada, monitoreo de menciones y manejo de respuestas.

A diferencia de los 18 conectores auto-habilitados (Discord, Telegram, etc.), Bluesky es un **plugin de registro** que debe instalarse manualmente antes de su uso. No se auto-habilita solo con la configuración del conector.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-bluesky` |
| Clave de configuración | `connectors.bluesky` |
| Instalación | `eliza plugins install @elizaos/plugin-bluesky` |

<div id="setup-requirements">

## Requisitos de configuración

</div>

- Credenciales de cuenta de Bluesky (handle y contraseña de aplicación)
- Genera una contraseña de aplicación en [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)

<div id="configuration">

## Configuración

</div>

```json
{
  "connectors": {
    "bluesky": {
      "enabled": true,
      "postEnable": true,
      "postIntervalMin": 90,
      "postIntervalMax": 180
    }
  }
}
```

<div id="environment-variables">

## Variables de entorno

</div>

| Variable | Descripción |
|----------|-------------|
| `BLUESKY_USERNAME` | Nombre de usuario/email de Bluesky |
| `BLUESKY_PASSWORD` | Contraseña de aplicación (no tu contraseña principal) |
| `BLUESKY_HANDLE` | Handle de Bluesky (por ejemplo, `yourname.bsky.social`) |
| `BLUESKY_ENABLED` | Establecer a `true` para habilitar |
| `BLUESKY_DRY_RUN` | Establecer a `true` para pruebas sin publicar |

<div id="features">

## Características

</div>

- Creación de publicaciones a intervalos configurables
- Monitoreo de menciones y respuestas
- Modo de prueba sin publicar
- Red social descentralizada basada en el Protocolo AT

<div id="related">

## Relacionado

</div>

- [Descripción general de conectores](/es/guides/connectors#bluesky)
