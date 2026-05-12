---
title: "Plugin de Gmail Watch"
sidebarTitle: "Gmail Watch"
description: "Conector de Gmail Watch para Eliza — monitorea bandejas de entrada de Gmail y responde a correos entrantes."
---

El plugin de Gmail Watch conecta agentes de Eliza a Gmail, permitiendo el monitoreo de correos entrantes y respuestas automatizadas.

**Package:** `@elizaos/plugin-gmail-watch`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-gmail-watch
```

<div id="setup">

## Configuración

</div>

<div id="1-enable-the-feature-flag">

### 1. Habilita el feature flag

</div>

El plugin de Gmail Watch se activa mediante el flag `features.gmailWatch` en tu configuración de Eliza:

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

<div id="2-configure-gmail-api-access">

### 2. Configura el acceso a la API de Gmail

</div>

Sigue la configuración de Google Cloud Console para habilitar la API de Gmail y obtener credenciales OAuth para tu agente.

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `features.gmailWatch` | Sí | Establecer `true` para habilitar el plugin de Gmail Watch |

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
