---
title: "API de Agentes"
sidebarTitle: "Agentes"
description: "Endpoints de la API REST para el ciclo de vida del agente, administración y transferencia (exportar/importar)."
---

Todos los endpoints de agentes requieren que el runtime del agente esté inicializado. El servidor de la API se ejecuta en el puerto **31337** por defecto y todas las rutas tienen el prefijo `/api/`. Cuando `ELIZA_API_TOKEN` está configurado, inclúyelo como un token `Bearer` en el encabezado `Authorization`.

<div id="endpoints">

## Endpoints

</div>

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/agent/start` | Iniciar el agente y habilitar la autonomía |
| POST | `/api/agent/stop` | Detener el agente y deshabilitar la autonomía |
| POST | `/api/agent/pause` | Pausar el agente (mantener el tiempo de actividad, deshabilitar la autonomía) |
| POST | `/api/agent/resume` | Reanudar un agente pausado y rehabilitar la autonomía |
| POST | `/api/agent/restart` | Reiniciar el runtime del agente |
| POST | `/api/agent/reset` | Borrar la configuración, el espacio de trabajo, la memoria y volver al estado de incorporación |
| POST | `/api/agent/export` | Exportar el agente como un archivo binario `.eliza-agent` cifrado con contraseña |
| GET | `/api/agent/export/estimate` | Estimar el tamaño del archivo de exportación antes de descargarlo |
| POST | `/api/agent/import` | Importar el agente desde un archivo `.eliza-agent` cifrado con contraseña |
| GET | `/api/agent/self-status` | Resumen estructurado del estado propio con capacidades, billetera, plugins y awareness |

---

<div id="post-apiagentstart">

### POST /api/agent/start

</div>

Iniciar el agente y habilitar la operación autónoma. Establece el estado del agente a `running`, registra la marca de tiempo de inicio y habilita la tarea de autonomía para que el primer tick se ejecute inmediatamente.

**Respuesta**

```json
{
  "ok": true,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 0,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentstop">

### POST /api/agent/stop

</div>

Detener el agente y deshabilitar la autonomía. Establece el estado del agente a `stopped` y limpia el seguimiento de tiempo de actividad.

**Respuesta**

```json
{
  "ok": true,
  "status": {
    "state": "stopped",
    "agentName": "Eliza"
  }
}
```

---

<div id="post-apiagentpause">

### POST /api/agent/pause

</div>

Pausar el agente manteniendo el tiempo de actividad intacto. Deshabilita la autonomía pero preserva la marca de tiempo `startedAt` y la información del modelo.

**Respuesta**

```json
{
  "ok": true,
  "status": {
    "state": "paused",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 34200000,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentresume">

### POST /api/agent/resume

</div>

Reanudar un agente pausado y rehabilitar la autonomía. El primer tick se ejecuta inmediatamente.

**Respuesta**

```json
{
  "ok": true,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "model": "@elizaos/plugin-anthropic",
    "uptime": 34200000,
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentrestart">

### POST /api/agent/restart

</div>

Reiniciar el runtime del agente. Devuelve `409` si ya hay un reinicio en progreso y `501` si el reinicio no es compatible en el modo actual.

**Respuesta**

```json
{
  "ok": true,
  "pendingRestart": false,
  "status": {
    "state": "running",
    "agentName": "Eliza",
    "startedAt": 1718000000000
  }
}
```

---

<div id="post-apiagentreset">

### POST /api/agent/reset

</div>

Borrar la configuración, el espacio de trabajo (memoria), los tokens OAuth y volver al estado de incorporación. Detiene el runtime, elimina el directorio de estado `~/.eliza/` (con comprobaciones de seguridad para evitar la eliminación de rutas del sistema) y restablece todo el estado del servidor.

**Respuesta**

```json
{
  "ok": true
}
```

---

<div id="post-apiagentexport">

### POST /api/agent/export

</div>

Exportar el agente completo como un archivo binario `.eliza-agent` cifrado con contraseña. El agente debe estar en ejecución. Devuelve una descarga de archivo `application/octet-stream`.

**Solicitud**

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `password` | string | Sí | Contraseña de cifrado — mínimo 4 caracteres |
| `includeLogs` | boolean | No | Si se deben incluir los archivos de log en la exportación |

**Respuesta**

Descarga de archivo binario con `Content-Disposition: attachment; filename="agentname-YYYY-MM-DDTHH-MM-SS.eliza-agent"`.

---

<div id="get-apiagentexportestimate">

### GET /api/agent/export/estimate

</div>

Estimar el tamaño del archivo de exportación antes de descargarlo. El agente debe estar en ejecución.

**Respuesta**

```json
{
  "estimatedBytes": 1048576,
  "estimatedMb": 1.0
}
```

---

<div id="post-apiagentimport">

### POST /api/agent/import

</div>

Importar un agente desde un archivo `.eliza-agent` cifrado con contraseña. El cuerpo de la solicitud es un envoltorio binario: `[4 bytes longitud de contraseña (uint32 big-endian)][bytes de contraseña][datos del archivo]`. El tamaño máximo de importación es 512 MB.

**Solicitud**

Cuerpo binario sin procesar — no JSON. Los primeros 4 bytes codifican la longitud de la contraseña como un entero sin signo de 32 bits en formato big-endian, seguido de la contraseña en UTF-8, seguido de los datos del archivo.

**Respuesta**

```json
{
  "ok": true
}
```

<div id="get-apiagentself-status">

### GET /api/agent/self-status

</div>

Obtener un resumen estructurado del estado actual del agente, sus capacidades, estado de la billetera, plugins activos y una instantánea opcional del registro de awareness. Diseñado para consumidores programáticos y el sistema de autoconciencia del agente.

**Respuesta**

```json
{
  "generatedAt": "2026-04-09T12:00:00.000Z",
  "state": "running",
  "agentName": "Eliza",
  "model": "anthropic/claude-sonnet-4.6",
  "provider": "anthropic",
  "automationMode": "connectors-only",
  "tradePermissionMode": "ask",
  "shellEnabled": true,
  "wallet": {
    "hasWallet": true,
    "hasEvm": true,
    "hasSolana": false,
    "evmAddress": "0x1234...abcd",
    "evmAddressShort": "0x1234...abcd",
    "solanaAddress": null,
    "solanaAddressShort": null,
    "localSignerAvailable": true,
    "managedBscRpcReady": true
  },
  "plugins": {
    "totalActive": 12,
    "active": ["..."],
    "aiProviders": ["@elizaos/plugin-anthropic"],
    "connectors": ["@elizaos/plugin-discord"]
  },
  "capabilities": {
    "canTrade": true,
    "canLocalTrade": true,
    "canAutoTrade": false,
    "canUseBrowser": false,
    "canUseComputer": false,
    "canRunTerminal": true,
    "canInstallPlugins": true,
    "canConfigurePlugins": true,
    "canConfigureConnectors": true
  },
  "registrySummary": "Runtime: running | Wallet: EVM ready | Plugins: 12 active | Cloud: disconnected"
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `generatedAt` | string | Marca de tiempo ISO 8601 de cuándo se generó la respuesta |
| `state` | string | Estado actual del agente (`not_started`, `starting`, `running`, `paused`, `stopped`, `restarting`, `error`) |
| `agentName` | string | Nombre para mostrar del agente |
| `model` | string\|null | Identificador del modelo activo, resuelto desde el estado del runtime, configuración o entorno |
| `provider` | string\|null | Etiqueta del proveedor de IA derivada de la cadena del modelo |
| `automationMode` | string | `"connectors-only"` o `"full"` — controla el alcance del comportamiento autónomo |
| `tradePermissionMode` | string | Nivel de permisos de trading desde la configuración |
| `shellEnabled` | boolean | Si el acceso a shell/terminal está habilitado |
| `wallet` | object | Resumen del estado de la billetera (ver abajo) |
| `plugins` | object | Resumen de plugins activos (ver abajo) |
| `capabilities` | object | Indicadores booleanos de capacidades (ver abajo) |
| `registrySummary` | string\|undefined | Resumen en una línea del registro de awareness, si está disponible |

**Campos de `wallet`**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `hasWallet` | boolean | `true` si hay alguna dirección de billetera configurada |
| `hasEvm` | boolean | `true` si hay una dirección EVM disponible |
| `hasSolana` | boolean | `true` si hay una dirección Solana disponible |
| `evmAddress` | string\|null | Dirección EVM completa |
| `evmAddressShort` | string\|null | Dirección EVM abreviada (`0x1234...abcd`) |
| `solanaAddress` | string\|null | Dirección Solana completa |
| `solanaAddressShort` | string\|null | Dirección Solana abreviada |
| `localSignerAvailable` | boolean | `true` si `EVM_PRIVATE_KEY` está configurado |
| `managedBscRpcReady` | boolean | `true` si el endpoint RPC gestionado de BSC está configurado |

**Campos de `plugins`**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `totalActive` | number | Cantidad de plugins activos |
| `active` | string[] | Nombres de todos los plugins activos |
| `aiProviders` | string[] | Nombres de los plugins de proveedores de IA activos |
| `connectors` | string[] | Nombres de los plugins de conectores activos (Discord, Telegram, etc.) |

**Campos de `capabilities`**

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `canTrade` | boolean | `true` si la billetera y el RPC están configurados para trading |
| `canLocalTrade` | boolean | `true` si la ejecución de operaciones locales está disponible (billetera + firmante + permiso) |
| `canAutoTrade` | boolean | `true` si el agente puede ejecutar operaciones de forma autónoma |
| `canUseBrowser` | boolean | `true` si hay un plugin de navegador cargado |
| `canUseComputer` | boolean | `true` si hay un plugin de uso de computadora cargado |
| `canRunTerminal` | boolean | `true` si el acceso a shell está habilitado |
| `canInstallPlugins` | boolean | `true` si la instalación de plugins está disponible |
| `canConfigurePlugins` | boolean | `true` si la configuración de plugins está disponible |
| `canConfigureConnectors` | boolean | `true` si la configuración de conectores está disponible |

---

<div id="common-error-codes">

## Códigos de error comunes

</div>

| Estado | Código | Descripción |
|--------|--------|-------------|
| 400 | `INVALID_REQUEST` | El cuerpo de la solicitud está malformado o faltan campos requeridos |
| 401 | `UNAUTHORIZED` | Token de autenticación faltante o inválido |
| 404 | `NOT_FOUND` | El recurso solicitado no existe |
| 409 | `STATE_CONFLICT` | El agente está en un estado inválido para esta operación |
| 500 | `INTERNAL_ERROR` | Error inesperado del servidor |
| 500 | `AGENT_NOT_FOUND` | Runtime del agente no encontrado o no inicializado |
