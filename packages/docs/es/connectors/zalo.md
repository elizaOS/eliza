---
title: Conector de Zalo
sidebarTitle: Zalo
description: Conecta tu agente a Zalo usando el paquete @elizaos/plugin-zalo.
---

Conecta tu agente a Zalo para mensajería de Cuenta Oficial y flujos de trabajo de soporte.

<div id="overview">

## Descripción general

</div>

El conector de Zalo es un plugin de elizaOS que conecta tu agente a la plataforma Zalo a través de la API de Cuenta Oficial. Este conector está disponible en el registro de plugins. También existe una variante de cuenta personal disponible como `@elizaos/plugin-zalouser`.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-zalo` |
| Clave de configuración | `connectors.zalo` |
| Instalación | `eliza plugins install @elizaos/plugin-zalo` |

<div id="setup-requirements">

## Requisitos de configuración

</div>

- Token de acceso de Cuenta Oficial (OA) de Zalo

<div id="configuration">

## Configuración

</div>

```json
{
  "connectors": {
    "zalo": {
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
| `ZALO_ACCESS_TOKEN` | Token de acceso de la OA |
| `ZALO_REFRESH_TOKEN` | Credencial de renovación de token |
| `ZALO_APP_ID` | ID de la aplicación |
| `ZALO_SECRET_KEY` | Clave secreta de la aplicación |

<div id="features">

## Características

</div>

- Mensajería y flujos de trabajo de soporte de Cuenta Oficial
- Manejo de mensajes basado en webhooks
- Gestión de interacción con clientes

<div id="related">

## Relacionado

</div>

- [Descripción general de conectores](/es/guides/connectors#zalo)
