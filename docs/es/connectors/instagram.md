---
title: Conector de Instagram
sidebarTitle: Instagram
description: Conecta tu agente a Instagram usando el paquete @elizaos/plugin-instagram.
---

Conecta tu agente a Instagram para publicación de medios, monitoreo de comentarios y manejo de mensajes directos.

<div id="overview">

## Descripción general

</div>

El conector de Instagram es un plugin de elizaOS que conecta tu agente a Instagram. Soporta publicación de medios con generación de descripciones, respuesta a comentarios y manejo de mensajes directos. Este conector está disponible en el registro de plugins.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-instagram` |
| Clave de configuración | `connectors.instagram` |
| Instalación | `eliza plugins install @elizaos/plugin-instagram` |

<div id="setup-requirements">

## Requisitos de configuración

</div>

- Credenciales de cuenta de Instagram (nombre de usuario y contraseña)

<div id="configuration">

## Configuración

</div>

```json
{
  "connectors": {
    "instagram": {
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
| `INSTAGRAM_USERNAME` | Nombre de usuario de Instagram |
| `INSTAGRAM_PASSWORD` | Contraseña de Instagram |
| `INSTAGRAM_DRY_RUN` | Establecer a `true` para pruebas sin publicar |
| `INSTAGRAM_POLL_INTERVAL` | Intervalo de sondeo en ms |
| `INSTAGRAM_POST_INTERVAL_MIN` | Segundos mínimos entre publicaciones |
| `INSTAGRAM_POST_INTERVAL_MAX` | Segundos máximos entre publicaciones |

<div id="features">

## Características

</div>

- Publicación de medios con generación de descripciones
- Monitoreo y respuesta a comentarios
- Manejo de mensajes directos
- Modo de prueba sin publicar
- Intervalos de publicación y sondeo configurables

<div id="related">

## Relacionado

</div>

- [Descripción general de conectores](/es/guides/connectors#instagram)
