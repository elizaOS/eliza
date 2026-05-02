---
title: "Plugin de GitHub"
sidebarTitle: "GitHub"
description: "Conector de GitHub para Eliza — interactúa con repositorios, issues y pull requests."
---

El plugin de GitHub conecta agentes de Eliza a GitHub, permitiendo interacciones con repositorios, issues, pull requests y otros recursos de GitHub.

**Package:** `@elizaos/plugin-github`

<div id="installation">

## Instalación

</div>

```bash
eliza plugins install @elizaos/plugin-github
```

<div id="setup">

## Configuración

</div>

<div id="1-create-a-github-personal-access-token">

### 1. Crea un token de acceso personal de GitHub

</div>

1. Ve a [github.com/settings/tokens](https://github.com/settings/tokens)
2. Haz clic en **Generate new token** (clásico) o **Fine-grained token**
3. Selecciona los permisos necesarios para tu caso de uso (por ejemplo, `repo`, `issues`, `pull_requests`)
4. Copia el token generado

<div id="2-configure-eliza">

### 2. Configura Eliza

</div>

```json
{
  "connectors": {
    "github": {
      "apiToken": "YOUR_API_TOKEN",
      "owner": "YOUR_GITHUB_OWNER",
      "repo": "YOUR_GITHUB_REPO"
    }
  }
}
```

O mediante variables de entorno:

```bash
export GITHUB_API_TOKEN=YOUR_API_TOKEN
export GITHUB_OWNER=YOUR_GITHUB_OWNER
export GITHUB_REPO=YOUR_GITHUB_REPO
```

<div id="configuration">

## Configuración

</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `apiToken` | Sí | Token de acceso personal de GitHub |
| `owner` | Sí | Propietario del repositorio de GitHub (usuario u organización) |
| `repo` | Sí | Nombre del repositorio de GitHub |
| `enabled` | No | Establecer `false` para deshabilitar (predeterminado: `true`) |

<div id="environment-variables">

## Variables de entorno

</div>

```bash
export GITHUB_API_TOKEN=YOUR_API_TOKEN
export GITHUB_OWNER=YOUR_GITHUB_OWNER
export GITHUB_REPO=YOUR_GITHUB_REPO
```

<div id="related">

## Relacionado

</div>

- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores
