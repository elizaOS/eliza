---
title: "API de Plugins y Registro"
sidebarTitle: "Plugins"
description: "Endpoints de la API REST para la gestión de plugins, el registro de plugins de elizaOS y las operaciones de plugins principales."
---

La API de plugins gestiona el sistema de plugins del agente. Cubre tres áreas: **gestión de plugins** (listar, configurar, activar/desactivar plugins instalados), **instalación de plugins** (instalar, desinstalar, expulsar, sincronizar desde npm) y el **registro de plugins** (explorar el catálogo comunitario de elizaOS).

Cuando `ELIZA_API_TOKEN` está configurado, inclúyelo como token `Bearer` en el encabezado `Authorization`.

<div id="endpoints">

## Endpoints

</div>

<div id="plugin-management">

### Plugin Management

</div>

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/plugins` | Listar todos los plugins con estado y configuración |
| PUT | `/api/plugins/:id` | Actualizar un plugin (activar/desactivar, configurar) |
| POST | `/api/plugins/:id/test` | Probar la conectividad de un plugin |
| GET | `/api/plugins/installed` | Listar paquetes de plugins instalados |
| GET | `/api/plugins/ejected` | Listar plugins expulsados (copia local) |

<div id="plugin-installation">

### Plugin Installation

</div>

| Method | Path | Descripción |
|--------|------|-------------|
| POST | `/api/plugins/install` | Instalar un plugin desde npm |
| POST | `/api/plugins/uninstall` | Desinstalar un plugin |
| POST | `/api/plugins/:id/eject` | Expulsar un plugin a una copia local |
| POST | `/api/plugins/:id/sync` | Sincronizar un plugin expulsado de vuelta a npm |
| POST | `/api/plugins/:id/reinject` | Restaurar un plugin expulsado a su versión del registro |

<div id="core-plugin-management">

### Core Plugin Management

</div>

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/core/status` | Estado del gestor principal |
| GET | `/api/plugins/core` | Listar plugins principales con estado |
| POST | `/api/plugins/core/toggle` | Alternar un plugin principal |

<div id="plugin-registry">

### Plugin Registry

</div>

| Method | Path | Descripción |
|--------|------|-------------|
| GET | `/api/registry/plugins` | Listar todos los plugins del registro |
| GET | `/api/registry/plugins/:name` | Obtener detalles de un plugin del registro |
| GET | `/api/registry/search` | Buscar en el registro |
| POST | `/api/registry/refresh` | Actualizar la caché del registro |
| GET | `/api/registry/status` | Estado de conexión del registro |
| POST | `/api/registry/register` | Registrar el agente en el registro |
| POST | `/api/registry/update-uri` | Actualizar la URI del agente en el registro |
| POST | `/api/registry/sync` | Sincronizar estado del agente con el registro |
| GET | `/api/registry/config` | Obtener configuración del registro |

---

<div id="plugin-management-1">

## Plugin Management

</div>

<div id="get-apiplugins">

### GET /api/plugins

</div>

Lista todos los plugins conocidos — incluidos, instalados y descubiertos desde la configuración. Cada entrada incluye el estado activado/activo, parámetros de configuración con valores actuales (valores sensibles enmascarados) y resultados de validación.

**Response**

```json
{
  "plugins": [
    {
      "id": "twitter",
      "name": "Twitter",
      "description": "Twitter/X integration",
      "category": "social",
      "enabled": true,
      "isActive": true,
      "configured": true,
      "loadError": null,
      "parameters": [
        {
          "key": "TWITTER_API_KEY",
          "required": true,
          "sensitive": true,
          "isSet": true,
          "currentValue": "sk-****...xxxx"
        }
      ],
      "validationErrors": [],
      "validationWarnings": []
    }
  ]
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | string | Identificador del plugin |
| `enabled` | boolean | Si el usuario lo quiere activo (basado en configuración) |
| `isActive` | boolean | Si realmente está cargado en el runtime |
| `configured` | boolean | Si todos los parámetros obligatorios están configurados |
| `loadError` | string\|null | Mensaje de error si está instalado pero falló al cargar |

---

<div id="put-apipluginsid">

### PUT /api/plugins/:id

</div>

Actualiza el estado de activación y/o la configuración de un plugin. Activar/desactivar un plugin programa un reinicio del runtime.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `enabled` | boolean | No | Activar o desactivar el plugin |
| `config` | object | No | Mapa de claves de parámetros a nuevos valores |

```json
{
  "enabled": true,
  "config": {
    "TWITTER_API_KEY": "sk-new-key"
  }
}
```

**Response**

```json
{
  "ok": true,
  "plugin": { "id": "twitter", "enabled": true, "..." : "..." }
}
```

**Errores**

| Estado | Condición |
|--------|-----------|
| 404 | Plugin no encontrado |
| 422 | La validación de configuración falló |

---

<div id="post-apipluginsidtest">

### POST /api/plugins/:id/test

</div>

Prueba la conectividad o configuración de un plugin. El comportamiento de la prueba es específico del plugin (por ejemplo, verificar la validez de la clave API, comprobar la accesibilidad del endpoint).

**Response**

```json
{
  "ok": true,
  "result": { "..." : "..." }
}
```

---

<div id="get-apipluginsinstalled">

### GET /api/plugins/installed

</div>

Lista todos los paquetes de plugins instalados con información de versión.

**Response**

```json
{
  "count": 3,
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "version": "1.2.0",
      "installedAt": "2025-06-01T12:00:00.000Z"
    }
  ]
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `count` | number | Número total de plugins instalados |
| `plugins` | array | Lista de paquetes de plugins instalados |

---

<div id="get-apipluginsejected">

### GET /api/plugins/ejected

</div>

Lista todos los plugins expulsados (plugins que han sido copiados a un directorio local para desarrollo).

**Response**

```json
{
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "localPath": "/path/to/local/plugin-twitter"
    }
  ]
}
```

---

<div id="plugin-installation-1">

## Plugin Installation

</div>

<div id="post-apipluginsinstall">

### POST /api/plugins/install

</div>

Instala un paquete de plugin desde npm. La instalación del plugin puede tomar un tiempo considerable dependiendo del tamaño del paquete y el árbol de dependencias. El SDK del cliente usa un timeout de 120 segundos para este endpoint (comparado con el timeout predeterminado usado para otras llamadas API).

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `name` | string | Sí | Nombre del paquete npm |
| `autoRestart` | boolean | No | Si se debe reiniciar el agente después de instalar (por defecto `true`) |

**Response**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="post-apipluginsuninstall">

### POST /api/plugins/uninstall

</div>

Desinstala un paquete de plugin.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `name` | string | Sí | Nombre del paquete npm |

**Response**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="post-apipluginsiideject">

### POST /api/plugins/:id/eject

</div>

Expulsa un plugin a un directorio local para desarrollo. Crea una copia local del código fuente del plugin que puede modificarse de forma independiente. Si el resultado indica que se requiere un reinicio, el runtime programa un reinicio automático.

**Response**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x ejected to local source."
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `pluginName` | string | Nombre del plugin expulsado |
| `requiresRestart` | boolean | Si el runtime se reiniciará para cargar la copia local |
| `message` | string | Mensaje de estado legible |

**Errores**

| Estado | Condición |
|--------|-----------|
| 422 | La expulsión falló (plugin no encontrado o ya expulsado) |

---

<div id="post-apipluginsidsync">

### POST /api/plugins/:id/sync

</div>

Sincroniza un plugin expulsado — reconstruye desde la copia local.

**Response**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x synced with upstream."
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `pluginName` | string | Nombre del plugin sincronizado |
| `requiresRestart` | boolean | Si el runtime se reiniciará para aplicar los cambios |
| `message` | string | Mensaje de estado legible |

**Errores**

| Estado | Condición |
|--------|-----------|
| 422 | La sincronización falló (plugin no expulsado o error de sincronización) |

---

<div id="post-apipluginsid-reinject">

### POST /api/plugins/:id/reinject

</div>

Restaura un plugin previamente expulsado a su versión del registro, eliminando la copia local.

**Response**

```json
{
  "ok": true,
  "pluginName": "@elizaos/plugin-x",
  "requiresRestart": true,
  "message": "@elizaos/plugin-x restored to registry version."
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `pluginName` | string | Nombre del plugin reinyectado |
| `requiresRestart` | boolean | Si el runtime se reiniciará para cargar la versión del registro |
| `message` | string | Mensaje de estado legible |

**Errores**

| Estado | Condición |
|--------|-----------|
| 422 | La reinyección falló (plugin no expulsado o error de reinyección) |

---

<div id="core-plugin-management-1">

## Core Plugin Management

</div>

<div id="get-apicorestatus">

### GET /api/core/status

</div>

Obtiene el estado del gestor principal y los plugins principales disponibles.

**Response**

```json
{
  "available": true,
  "corePlugins": ["knowledge", "sql"],
  "optionalCorePlugins": ["plugin-manager"]
}
```

- **knowledge** -- Recuperación de conocimiento RAG
- **sql** -- Capa de base de datos

---

<div id="get-apipluginscore">

### GET /api/plugins/core

</div>

Lista los plugins principales y opcionales con su estado de activación/carga.

**Response**

```json
{
  "core": [
    { "name": "knowledge", "loaded": true, "required": true },
    { "name": "sql", "loaded": true, "required": true }
  ],
  "optionalCore": [
    { "name": "plugin-manager", "loaded": true, "required": false, "enabled": true }
  ]
}
```

---

<div id="post-apipluginscoretoggle">

### POST /api/plugins/core/toggle

</div>

Alterna un plugin principal opcional entre activado y desactivado.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `name` | string | Sí | Nombre del plugin principal |
| `enabled` | boolean | Sí | Estado deseado |

**Response**

```json
{
  "ok": true,
  "requiresRestart": true
}
```

---

<div id="plugin-registry-1">

## Plugin Registry

</div>

<div id="get-apiregistryplugins">

### GET /api/registry/plugins

</div>

Lista todos los plugins del registro de elizaOS con estado de instalación y carga.

**Response**

```json
{
  "count": 87,
  "plugins": [
    {
      "name": "@elizaos/plugin-x",
      "displayName": "Twitter",
      "description": "Twitter/X integration for posting and monitoring",
      "npm": {
        "package": "@elizaos/plugin-x",
        "version": "1.2.0"
      },
      "installed": false,
      "installedVersion": null,
      "loaded": false,
      "bundled": false
    }
  ]
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `name` | string | Nombre completo del paquete npm |
| `installed` | boolean | Si este plugin está actualmente instalado |
| `installedVersion` | string\|null | Versión instalada, o `null` si no está instalado |
| `loaded` | boolean | Si este plugin está cargado en el runtime del agente en ejecución |
| `bundled` | boolean | Si este plugin está incluido en el binario de Eliza |

---

<div id="get-apiregistrypluginsname">

### GET /api/registry/plugins/:name

</div>

Obtiene detalles de un plugin específico del registro. El parámetro `name` debe estar codificado en URL si contiene barras (por ejemplo, `%40elizaos%2Fplugin-twitter`).

**Path Parameters**

| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `name` | string | Sí | Nombre completo del paquete npm (codificado en URL) |

**Response**

```json
{
  "plugin": {
    "name": "@elizaos/plugin-x",
    "displayName": "Twitter",
    "description": "Twitter/X integration for posting and monitoring",
    "npm": {
      "package": "@elizaos/plugin-x",
      "version": "1.2.0"
    },
    "author": "elizaOS Team",
    "repository": "https://github.com/elizaos/eliza",
    "tags": ["social", "twitter"],
    "installed": false,
    "loaded": false,
    "bundled": false
  }
}
```

---

<div id="get-apiregistrysearch">

### GET /api/registry/search

</div>

Busca en el registro de plugins por palabra clave.

**Query Parameters**

| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|-------------|-------------|
| `q` | string | Sí | Consulta de búsqueda |
| `limit` | integer | No | Máximo de resultados a devolver (por defecto: 15, máximo: 50) |

**Response**

```json
{
  "query": "twitter",
  "count": 2,
  "results": [
    {
      "name": "@elizaos/plugin-x",
      "displayName": "Twitter",
      "description": "Twitter/X integration",
      "npmPackage": "@elizaos/plugin-x",
      "version": "1.2.0"
    }
  ]
}
```

---

<div id="post-apiregistryrefresh">

### POST /api/registry/refresh

</div>

Fuerza la actualización de la caché local del registro desde el registro upstream de elizaOS.

**Response**

```json
{
  "ok": true,
  "count": 87
}
```

---

<div id="get-apiregistrystatus">

### GET /api/registry/status

</div>

Obtiene el estado de conexión del agente con el registro.

**Response**

Cuando el servicio de registro está configurado:

```json
{
  "registered": true,
  "configured": true,
  "tokenId": 1,
  "agentName": "Eliza",
  "agentEndpoint": "https://...",
  "capabilitiesHash": "...",
  "isActive": true,
  "tokenURI": "https://...",
  "walletAddress": "0x...",
  "totalAgents": 42
}
```

Cuando el servicio de registro no está configurado:

```json
{
  "registered": false,
  "configured": false,
  "tokenId": 0,
  "agentName": "",
  "agentEndpoint": "",
  "capabilitiesHash": "",
  "isActive": false,
  "tokenURI": "",
  "walletAddress": "",
  "totalAgents": 0
}
```

---

<div id="post-apiregistryregister">

### POST /api/registry/register

</div>

Registra el agente en el registro de elizaOS.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `name` | string | No | Nombre alternativo del agente |
| `endpoint` | string | No | URL del endpoint público |
| `tokenURI` | string | No | URI del token para el registro |

**Response**

Devuelve el resultado del registro desde el servicio de registro (el esquema depende de la implementación del registro).

---

<div id="post-apiregistryupdate-uri">

### POST /api/registry/update-uri

</div>

Actualiza la URI del token del agente en el registro.

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `tokenURI` | string | Sí | Nueva URI del token |

**Response**

```json
{
  "ok": true
}
```

---

<div id="post-apiregistrysync">

### POST /api/registry/sync

</div>

Sincroniza el estado del agente con el registro (heartbeat, actualización de estado).

**Request Body**

| Campo | Tipo | Obligatorio | Descripción |
|-------|------|-------------|-------------|
| `name` | string | No | Nombre alternativo del agente |
| `endpoint` | string | No | URL del endpoint público |
| `tokenURI` | string | No | URI del token |

**Response**

```json
{
  "ok": true,
  "txHash": "0x..."
}
```

---

<div id="get-apiregistryconfig">

### GET /api/registry/config

</div>

Obtiene la configuración actual del registro. Devuelve el contenido de `config.registry` junto con metadatos de la cadena.

**Response**

```json
{
  "chainId": 1,
  "explorerUrl": "https://etherscan.io",
  "...": "additional fields from config.registry"
}
```

La forma exacta de la respuesta depende de lo que esté configurado en `eliza.json` bajo la clave `registry`.
