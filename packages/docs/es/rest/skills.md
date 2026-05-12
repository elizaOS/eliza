---
title: "API de Skills"
sidebarTitle: "Skills"
description: "Endpoints de la API REST para gestionar skills locales, el catálogo de skills y el marketplace de skills."
---

La API de skills cubre tres áreas: **skills locales** (archivos de acciones TypeScript específicos del agente), el **catálogo de skills** (registro curado de skills de la comunidad) y el **marketplace de skills** (paquetes de skills basados en npm). Los skills extienden el agente con nuevas acciones, proveedores o evaluadores.

Cuando `ELIZA_API_TOKEN` está configurado, inclúyelo como token `Bearer` en el encabezado `Authorization`.

<div id="endpoints">

## Endpoints

</div>

<div id="local-skills">

### Local Skills

</div>

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/skills` | Listar todos los skills locales con metadatos |
| POST | `/api/skills/refresh` | Re-escanear el directorio de skills |
| GET | `/api/skills/:id/scan` | Escanear un archivo de skill y devolver metadatos parseados |
| POST | `/api/skills/create` | Crear un nuevo archivo de skill desde una plantilla |
| POST | `/api/skills/:id/open` | Abrir un archivo de skill en el editor predeterminado |
| GET | `/api/skills/:id/source` | Leer el código fuente de un skill |
| PUT | `/api/skills/:id/source` | Escribir código fuente actualizado para un skill |
| POST | `/api/skills/:id/enable` | Activar un skill (respeta confirmaciones de escaneo) |
| POST | `/api/skills/:id/disable` | Desactivar un skill |

<div id="skills-catalog">

### Skills Catalog

</div>

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/skills/catalog` | Listar el catálogo de skills con paginación |
| GET | `/api/skills/catalog/search` | Buscar en el catálogo por consulta |
| GET | `/api/skills/catalog/:id` | Obtener detalles de una entrada del catálogo |
| POST | `/api/skills/catalog/refresh` | Actualizar el catálogo desde el registro remoto |
| POST | `/api/skills/catalog/install` | Instalar un skill del catálogo |
| POST | `/api/skills/catalog/uninstall` | Desinstalar un skill del catálogo |

<div id="skills-marketplace">

### Skills Marketplace

</div>

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/skills/marketplace/search` | Buscar skills en el marketplace npm |
| GET | `/api/skills/marketplace/installed` | Listar skills del marketplace instalados |
| POST | `/api/skills/marketplace/install` | Instalar un skill desde npm |
| POST | `/api/skills/marketplace/uninstall` | Desinstalar un skill del marketplace |
| GET | `/api/skills/marketplace/config` | Obtener configuración del marketplace |
| PUT | `/api/skills/marketplace/config` | Actualizar configuración del marketplace |

---

<div id="local-skills-1">

## Local Skills

</div>

<div id="get-apiskills">

### GET /api/skills

</div>

Lista todos los skills locales encontrados en el directorio de skills del agente. Cada entrada incluye la ruta del archivo, metadatos de acción parseados y preferencias de activación/prioridad.

**Response**

```json
{
  "skills": [
    {
      "id": "my-custom-action",
      "name": "MY_CUSTOM_ACTION",
      "description": "Does something useful",
      "filePath": "/path/to/skills/my-custom-action.ts",
      "enabled": true,
      "priority": 0,
      "valid": true
    }
  ]
}
```

---

<div id="post-apiskillsrefresh">

### POST /api/skills/refresh

</div>

Re-escanea el directorio de skills y recarga todos los metadatos de skills. Útil después de añadir o editar archivos de skills manualmente.

**Response**

```json
{
  "ok": true,
  "count": 5
}
```

---

<div id="get-apiskillsidscan">

### GET /api/skills/:id/scan

</div>

Escanea un único archivo de skill y devuelve sus metadatos AST parseados — acciones exportadas, proveedores y evaluadores.

**Response**

```json
{
  "id": "my-skill",
  "actions": [
    {
      "name": "MY_ACTION",
      "description": "Action description",
      "similes": ["DO_THING"],
      "parameters": []
    }
  ],
  "providers": [],
  "evaluators": []
}
```

---

<div id="post-apiskillscreate">

### POST /api/skills/create

</div>

Crea un nuevo archivo de skill desde una plantilla incorporada.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `name` | string | Sí | Nombre del archivo de skill (por ejemplo, `my-action`) |
| `template` | string | No | Plantilla a usar — por defecto una plantilla de acción básica |

**Response**

```json
{
  "ok": true,
  "skill": {
    "id": "my-action",
    "filePath": "/path/to/skills/my-action.ts"
  }
}
```

---

<div id="post-apiskillsidopen">

### POST /api/skills/:id/open

</div>

Abre el archivo de skill en el editor de código predeterminado del sistema.

**Response**

```json
{
  "ok": true
}
```

---

<div id="get-apiskillsidsource">

### GET /api/skills/:id/source

</div>

Lee el código fuente TypeScript sin procesar de un archivo de skill.

**Response**

```json
{
  "id": "my-skill",
  "source": "import { Action } from '@elizaos/core';\n\nexport const myAction: Action = { ... };"
}
```

---

<div id="put-apiskillsidsource">

### PUT /api/skills/:id/source

</div>

Escribe código fuente actualizado en un archivo de skill. El servidor valida la sintaxis básica antes de guardar.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `source` | string | Sí | El nuevo código fuente TypeScript |

**Response**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillsidenable">

### POST /api/skills/:id/enable

</div>

Activa un skill instalado. Devuelve 409 si el skill tiene hallazgos de escaneo no confirmados — confirma primero vía `POST /api/skills/:id/acknowledge`.

**Response**

```json
{
  "ok": true,
  "skill": {
    "id": "my-skill",
    "enabled": true
  },
  "scanStatus": null
}
```

---

<div id="post-apiskillsiddisable">

### POST /api/skills/:id/disable

</div>

Desactiva un skill instalado.

**Response**

```json
{
  "ok": true,
  "skill": {
    "id": "my-skill",
    "enabled": false
  },
  "scanStatus": null
}
```

---

<div id="skills-catalog-1">

## Skills Catalog

</div>

<div id="get-apiskillscatalog">

### GET /api/skills/catalog

</div>

Explora el catálogo curado de skills con paginación y ordenamiento.

**Query Parameters**

| Parámetro | Tipo | Por defecto | Descripción |
|-----------|------|-------------|-------------|
| `page` | number | 1 | Número de página |
| `perPage` | number | 50 | Elementos por página (máximo 100) |
| `sort` | string | `downloads` | Campo de ordenamiento |

**Response**

```json
{
  "skills": [
    {
      "id": "greeting-skill",
      "name": "Greeting Skill",
      "description": "Custom greeting actions",
      "author": "community",
      "downloads": 1234,
      "installed": false
    }
  ],
  "total": 42,
  "page": 1,
  "perPage": 50
}
```

---

<div id="get-apiskillscatalogsearch">

### GET /api/skills/catalog/search

</div>

Busca en el catálogo por consulta de texto.

**Query Parameters**

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `q` | string | Consulta de búsqueda (obligatorio) |
| `limit` | number | Máximo de resultados (por defecto 30, máximo 100) |

**Response**

```json
{
  "skills": [ ... ],
  "total": 5
}
```

---

<div id="get-apiskillscatalogid">

### GET /api/skills/catalog/:id

</div>

Obtiene detalles completos de una entrada individual del catálogo de skills.

**Response**

```json
{
  "skill": {
    "id": "greeting-skill",
    "name": "Greeting Skill",
    "description": "Full description...",
    "author": "community",
    "version": "1.0.0",
    "installed": false,
    "readme": "# Greeting Skill\n..."
  }
}
```

---

<div id="post-apiskillscatalogrefresh">

### POST /api/skills/catalog/refresh

</div>

Fuerza la actualización del catálogo desde el registro remoto.

**Response**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillscataloginstall">

### POST /api/skills/catalog/install

</div>

Instala un skill desde el catálogo.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `id` | string | Sí | ID del skill en el catálogo |

**Response**

```json
{
  "ok": true,
  "skill": { "id": "greeting-skill", "installed": true }
}
```

---

<div id="post-apiskillscataloguninstall">

### POST /api/skills/catalog/uninstall

</div>

Desinstala un skill del catálogo previamente instalado.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `id` | string | Sí | ID del skill en el catálogo |

**Response**

```json
{
  "ok": true
}
```

---

<div id="skills-marketplace-1">

## Skills Marketplace

</div>

<div id="get-apiskillsmarketplacesearch">

### GET /api/skills/marketplace/search

</div>

Busca en el marketplace de skills basado en npm.

**Query Parameters**

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `q` | string | Consulta de búsqueda |
| `limit` | number | Máximo de resultados (por defecto 30, máximo 100) |

**Response**

```json
{
  "results": [
    {
      "name": "@community/skill-weather",
      "description": "Weather lookup skill",
      "version": "2.1.0"
    }
  ]
}
```

---

<div id="get-apiskillsmarketplaceinstalled">

### GET /api/skills/marketplace/installed

</div>

Lista todos los skills del marketplace actualmente instalados.

**Response**

```json
{
  "skills": [
    {
      "name": "@community/skill-weather",
      "version": "2.1.0",
      "installedAt": "2025-06-01T12:00:00Z"
    }
  ]
}
```

---

<div id="post-apiskillsmarketplaceinstall">

### POST /api/skills/marketplace/install

</div>

Instala un paquete de skill desde el marketplace npm.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `name` | string | Sí | Nombre del paquete npm |
| `version` | string | No | Versión específica (por defecto la última) |

**Response**

```json
{
  "ok": true
}
```

---

<div id="post-apiskillsmarketplaceuninstall">

### POST /api/skills/marketplace/uninstall

</div>

Desinstala un paquete de skill del marketplace.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `name` | string | Sí | Nombre del paquete npm |

**Response**

```json
{
  "ok": true
}
```

---

<div id="get-apiskillsmarketplaceconfig">

### GET /api/skills/marketplace/config

</div>

Obtiene la configuración actual del marketplace.

**Response**

```json
{
  "config": { ... }
}
```

---

<div id="put-apiskillsmarketplaceconfig">

### PUT /api/skills/marketplace/config

</div>

Actualiza la configuración del marketplace.

**Request Body**

Objeto de configuración arbitrario — varía según el backend del marketplace.

**Response**

```json
{
  "ok": true
}
```

<div id="acknowledge-skill-findings">

## Acknowledge Skill Findings

</div>

```
POST /api/skills/:id/acknowledge
```

Confirma los hallazgos del escaneo de seguridad de un skill. Obligatorio antes de que el skill pueda ser activado. Opcionalmente activa el skill en la misma solicitud.

**Path params:**

| Param | Tipo | Descripción |
|-------|------|-------------|
| `id` | string | Slug del skill |

**Request body:**
```json
{ "enable": true }
```

`enable` es opcional — omítelo o configúralo como `false` para confirmar sin activar.

**Response — hallazgos presentes:**
```json
{
  "ok": true,
  "skillId": "my-skill",
  "acknowledged": true,
  "enabled": true,
  "findingCount": 3
}
```

**Response — sin hallazgos (escaneo limpio):**
```json
{
  "ok": true,
  "message": "No findings to acknowledge.",
  "acknowledged": true
}
```

**Errores:** `404` no se encontró informe de escaneo; `403` el estado del skill es `"blocked"` (no se puede confirmar).

---

<div id="skills-catalog-and-marketplace-runbook">

## Guía operativa del catálogo y marketplace de skills

</div>

<div id="setup-checklist">

### Lista de verificación de configuración

</div>

1. Confirma que el directorio de skills (`~/.eliza/workspace/skills/`) sea legible y escribible por el runtime.
2. Confirma que el acceso de red/registro del marketplace esté disponible (por defecto: `https://clawhub.ai`). Verifica las variables de entorno `SKILLS_REGISTRY`, `CLAWHUB_REGISTRY` o `SKILLS_MARKETPLACE_URL`.
3. Confirma que los prerrequisitos del instalador de plugins (`bun` y `git`) estén presentes en el PATH del runtime.
4. Para el marketplace legacy SkillsMP, configura `SKILLSMP_API_KEY` en el entorno.
5. Verifica que el archivo del catálogo exista en una de las rutas esperadas (incluido con `@elizaos/plugin-agent-skills`).

<div id="failure-modes">

### Modos de fallo

</div>

**Búsqueda y catálogo:**

- La búsqueda devuelve resultados vacíos inesperadamente:
  Verifica la entrada de consulta, la disponibilidad del registro upstream y la limitación de velocidad. La coincidencia difusa usa slug, nombre, resumen y etiquetas — prueba con términos de búsqueda más amplios.
- La caché del catálogo está desactualizada:
  La caché en memoria expira después de 10 minutos. Fuerza la actualización con `POST /api/skills/catalog/refresh` o reinicia el agente.

**Instalación y desinstalación:**

- La instalación falla con error de red:
  Verifica la validez del nombre/versión del paquete, los permisos del instalador y la red. El instalador usa sparse checkout para instalaciones basadas en git — confirma que `git` esté disponible.
- El escaneo de seguridad bloquea la instalación (estado `blocked`):
  El escaneo detectó archivos binarios (`.exe`, `.dll`, `.so`), escapes de symlink o un `SKILL.md` faltante. El directorio del skill se elimina automáticamente.
- La instalación falla con "already installed":
  Ya existe un registro para este ID de skill. Desinstala primero con `POST /api/skills/marketplace/uninstall`, luego reintenta.
- La desinstalación deja estado residual:
  Actualiza la lista de skills y verifica que el paquete se haya eliminado de `marketplace-installs.json`.

**Carga de skills:**

- El skill personalizado no aparece en `/api/skills`:
  Confirma que el directorio del skill contenga un `SKILL.md` válido con frontmatter de nombre/descripción. Ejecuta `POST /api/skills/refresh` para re-escanear.
- El skill carga pero está desactivado:
  Verifica la cascada de activación/desactivación: las preferencias de base de datos anulan la configuración, `denyBundled` bloquea incondicionalmente.

<div id="recovery-procedures">

### Procedimientos de recuperación

</div>

1. **Instalación del marketplace corrupta:** Elimina `~/.eliza/workspace/skills/.marketplace/<skill-id>/` y remueve su entrada de `~/.eliza/workspace/skills/.cache/marketplace-installs.json`, luego reinstala.
2. **Archivo del catálogo faltante:** Reinstala o actualiza `@elizaos/plugin-agent-skills` para restaurar el catálogo incluido.
3. **Conflicto de sobrescritura de skills:** Si un skill del workspace sobrescribe inesperadamente un skill incluido, renombra el directorio del skill del workspace o muévelo a una ubicación diferente.

<div id="verification-commands">

### Comandos de verificación

</div>

```bash
# Skill catalog and marketplace unit tests
bunx vitest run src/services/plugin-installer.test.ts src/services/skill-marketplace.test.ts src/services/skill-catalog-client.test.ts

# Skills marketplace API and services e2e
bunx vitest run --config test/vitest/e2e.config.ts test/skills-marketplace-api.e2e.test.ts test/skills-marketplace-services.e2e.test.ts

# API server e2e (includes skills routes)
bunx vitest run --config test/vitest/e2e.config.ts test/api-server.e2e.test.ts

bun run typecheck
```

<div id="common-error-codes">

## Códigos de error comunes

</div>

| Estado | Código | Descripción |
|--------|--------|-------------|
| 400 | `INVALID_REQUEST` | El cuerpo de la solicitud está malformado o faltan campos obligatorios |
| 401 | `UNAUTHORIZED` | Token de autenticación faltante o inválido |
| 404 | `NOT_FOUND` | El recurso solicitado no existe |
| 500 | `SKILL_BLOCKED` | El skill está bloqueado debido a hallazgos del escaneo de seguridad |
| 500 | `SYNTAX_ERROR` | El código fuente del skill contiene errores de sintaxis |
| 500 | `ALREADY_INSTALLED` | El skill ya está instalado |
| 500 | `INTERNAL_ERROR` | Error inesperado del servidor |
