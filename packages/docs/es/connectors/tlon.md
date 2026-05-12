---
title: Conector de Tlon
sidebarTitle: Tlon
description: Conecta tu agente a Tlon/Urbit usando el paquete @elizaos/plugin-tlon.
---

Conecta tu agente a la red Urbit a través de Tlon para mensajería ship-to-ship.

<div id="overview">

## Descripción general

</div>

El conector de Tlon es un plugin de elizaOS que conecta tu agente a la red Urbit. Soporta mensajería ship-to-ship y participación en chats grupales. Este conector está disponible en el registro de plugins.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-tlon` |
| Clave de configuración | `connectors.tlon` |
| Instalación | `eliza plugins install @elizaos/plugin-tlon` |

<div id="setup-requirements">

## Requisitos de configuración

</div>

- Credenciales del ship de Tlon (nombre del ship de Urbit y código de acceso)

<div id="configuration">

## Configuración

</div>

```json
{
  "connectors": {
    "tlon": {
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
| `TLON_SHIP` | Nombre del ship de Urbit |
| `TLON_CODE` | Código de acceso del ship |
| `TLON_URL` | URL del ship |

<div id="features">

## Características

</div>

- Chat e interacciones sociales basadas en Urbit
- Mensajería ship-to-ship
- Participación en chats grupales

<div id="related">

## Relacionado

</div>

- [Descripción general de conectores](/es/guides/connectors#tlon)
