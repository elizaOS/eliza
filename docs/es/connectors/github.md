---
title: Conector de GitHub
sidebarTitle: GitHub
description: Conecta tu agente a GitHub usando el paquete @elizaos/plugin-github.
---

Conecta tu agente a GitHub para gestión de repositorios, seguimiento de issues y flujos de trabajo de pull requests.

<div id="overview">

## Descripción general

</div>

El conector de GitHub es un plugin de elizaOS que conecta tu agente a la API de GitHub. Soporta gestión de repositorios, seguimiento de issues, creación y revisión de pull requests, y búsqueda de código. Este conector está disponible en el registro de plugins.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-github` |
| Clave de configuración | `connectors.github` |
| Instalación | `eliza plugins install @elizaos/plugin-github` |

<div id="setup-requirements">

## Requisitos de configuración

</div>

- Token de API de GitHub (token de acceso personal o token de granularidad fina)

<div id="configuration">

## Configuración

</div>

```json
{
  "connectors": {
    "github": {
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
| `GITHUB_API_TOKEN` | Token de acceso personal o token de granularidad fina |
| `GITHUB_OWNER` | Propietario del repositorio por defecto |
| `GITHUB_REPO` | Nombre del repositorio por defecto |

<div id="features">

## Características

</div>

- Gestión de repositorios
- Seguimiento y creación de issues
- Flujos de trabajo de pull requests (crear, revisar, fusionar)
- Búsqueda de código y acceso a archivos

<div id="related">

## Relacionado

</div>

- [Descripción general de conectores](/es/guides/connectors#github)
