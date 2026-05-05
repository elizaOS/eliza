---
title: Conector de Signal
sidebarTitle: Signal
description: Conecta tu agente a Signal usando el paquete @elizaos/plugin-signal.
---

Conecta tu agente a Signal para mensajería privada y grupal a través de signal-cli.

<div id="overview">

## Descripción general

</div>

El conector de Signal es un plugin externo de elizaOS que conecta tu agente con Signal a través de signal-cli ejecutándose en modo HTTP o JSON-RPC. Se habilita automáticamente por el runtime cuando se detecta una configuración de cuenta válida.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-signal` |
| Clave de configuración | `connectors.signal` |
| Activador de auto-habilitación | `token`/`botToken`/`apiKey`, O cualquiera de `authDir`/`account`/`httpUrl`/`httpHost`/`httpPort`/`cliPath`, O `accounts` con entradas configuradas |

<div id="minimal-configuration">

## Configuración mínima

</div>

En `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "signal": {
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="setup">

## Instalación

</div>

<div id="1-install-signal-cli">

### 1. Instalar signal-cli

</div>

Instala [signal-cli](https://github.com/AsamK/signal-cli) y registra o vincula una cuenta de Signal:

```bash
signal-cli -a +1234567890 register
signal-cli -a +1234567890 verify CODE
```

<div id="2-start-signal-cli-in-http-mode">

### 2. Iniciar signal-cli en modo HTTP

</div>

```bash
signal-cli -a +1234567890 daemon --http localhost:8080
```

<div id="3-configure-eliza">

### 3. Configurar Eliza

</div>

Añade el bloque `connectors.signal` a `eliza.json` como se muestra en la configuración mínima anterior.

<div id="disabling">

## Deshabilitación

</div>

Para deshabilitar explícitamente el conector incluso cuando hay una cuenta configurada:

```json
{
  "connectors": {
    "signal": {
      "account": "+1234567890",
      "httpUrl": "http://localhost:8080",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">

## Mecanismo de auto-habilitación

</div>

El módulo `plugin-auto-enable.ts` verifica `connectors.signal` en tu configuración. El plugin se auto-habilita cuando se cumple cualquiera de las siguientes condiciones (y `enabled` no es explícitamente `false`):

- `account` está configurado junto con `httpUrl`
- `cliPath` está configurado (ruta al binario de signal-cli para inicio automático)
- `accounts` contiene al menos una entrada configurada

No se requiere ninguna variable de entorno para activar la auto-habilitación — se controla completamente mediante el objeto de configuración del conector.

<div id="environment-variables">

## Variables de entorno

</div>

El runtime inyecta las siguientes variables de entorno desde tu configuración `connectors.signal` en `process.env` a través de `CHANNEL_ENV_MAP`, para que el plugin pueda leerlas al iniciar:

| Variable de entorno | Campo de configuración de origen | Descripción |
|---|---|---|
| `SIGNAL_AUTH_DIR` | `authDir` | Ruta al directorio de datos de signal-cli |
| `SIGNAL_ACCOUNT_NUMBER` | `account` | Número de teléfono de Signal (E.164) |
| `SIGNAL_HTTP_URL` | `httpUrl` | URL HTTP del daemon de signal-cli |
| `SIGNAL_CLI_PATH` | `cliPath` | Ruta al binario de signal-cli |

No necesitas configurar estas manualmente — se derivan de la configuración del conector en tiempo de ejecución.

<div id="full-configuration-reference">

## Referencia completa de configuración

</div>

Todos los campos se definen bajo `connectors.signal` en `eliza.json`.

<div id="core-fields">

### Campos principales

</div>

| Campo | Tipo | Predeterminado | Descripción |
|-------|------|---------|-------------|
| `account` | string | — | Número de teléfono de Signal en formato E.164 (ej. `+1234567890`) |
| `httpUrl` | string | — | URL HTTP del daemon de signal-cli (ej. `http://localhost:8080`) |
| `httpHost` | string | — | Alternativa de nombre de host a `httpUrl` |
| `httpPort` | integer > 0 | — | Alternativa de puerto a `httpUrl` |
| `cliPath` | string | — | Ruta al binario de signal-cli para inicio automático |
| `autoStart` | boolean | — | Iniciar automáticamente signal-cli cuando el conector se carga |
| `startupTimeoutMs` | integer (1000-120000) | — | Milisegundos de espera para el inicio del CLI (1-120 segundos) |
| `receiveMode` | `"on-start"` \| `"manual"` | `"on-start"` | Cuándo comenzar a recibir mensajes |
| `name` | string | — | Nombre de visualización de la cuenta |
| `enabled` | boolean | — | Habilitar/deshabilitar explícitamente |
| `capabilities` | string[] | — | Indicadores de capacidad |
| `configWrites` | boolean | — | Permitir escrituras de configuración desde eventos de Signal |

<div id="message-handling">

### Manejo de mensajes

</div>

| Campo | Tipo | Predeterminado | Descripción |
|-------|------|---------|-------------|
| `ignoreAttachments` | boolean | — | Ignorar archivos adjuntos entrantes (el comportamiento predeterminado los incluye) |
| `ignoreStories` | boolean | — | Ignorar mensajes de historias (el comportamiento predeterminado los excluye) |
| `sendReadReceipts` | boolean | — | Enviar confirmaciones de lectura para mensajes recibidos |
| `historyLimit` | integer >= 0 | — | Máximo de mensajes en contexto |
| `dmHistoryLimit` | integer >= 0 | — | Límite de historial para mensajes directos |
| `dms` | object | — | Anulaciones de historial por mensaje directo indexadas por ID de DM. Cada valor: `{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | Máximo de caracteres por fragmento de mensaje |
| `chunkMode` | `"length"` \| `"newline"` | — | Estrategia de división de mensajes largos |
| `mediaMaxMb` | integer > 0 | — | Tamaño máximo de archivo multimedia en MB |
| `markdown` | object | — | Renderizado de tablas: `tables` puede ser `"off"`, `"bullets"` o `"code"` |

<div id="access-policies">

### Políticas de acceso

</div>

| Campo | Tipo | Predeterminado | Descripción |
|-------|------|---------|-------------|
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | Política de acceso a mensajes directos. `"open"` requiere que `allowFrom` incluya `"*"` |
| `allowFrom` | (string\|number)[] | — | IDs de usuario permitidos para enviar mensajes directos |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Política de unión a grupos |
| `groupAllowFrom` | (string\|number)[] | — | IDs de usuario permitidos en grupos |

<div id="streaming-configuration">

### Configuración de streaming

</div>

| Campo | Tipo | Predeterminado | Descripción |
|-------|------|---------|-------------|
| `blockStreaming` | boolean | — | Deshabilitar streaming completamente |
| `blockStreamingCoalesce` | object | — | Configuración de fusión: `minChars`, `maxChars`, `idleMs` |

<div id="actions">

### Acciones

</div>

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `actions.reactions` | boolean | Enviar reacciones |

<div id="reaction-notifications">

### Notificaciones de reacciones

</div>

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `reactionNotifications` | `"off"` \| `"own"` \| `"all"` \| `"allowlist"` | Qué reacciones activan notificaciones |
| `reactionAllowlist` | (string\|number)[] | IDs de usuario cuyas reacciones activan notificaciones (cuando `reactionNotifications` es `"allowlist"`) |
| `reactionLevel` | `"off"` \| `"ack"` \| `"minimal"` \| `"extensive"` | Nivel de detalle de la respuesta a reacciones |

<div id="heartbeat">

### Heartbeat

</div>

```json
{
  "connectors": {
    "signal": {
      "heartbeat": {
        "showOk": true,
        "showAlerts": true,
        "useIndicator": true
      }
    }
  }
}
```

<div id="multi-account-support">

### Soporte multi-cuenta

</div>

El campo `accounts` permite ejecutar múltiples cuentas de Signal desde un solo agente:

```json
{
  "connectors": {
    "signal": {
      "accounts": {
        "personal": {
          "account": "+1234567890",
          "httpUrl": "http://localhost:8080",
          "dmPolicy": "pairing"
        },
        "work": {
          "account": "+0987654321",
          "httpUrl": "http://localhost:8081",
          "dmPolicy": "allowlist",
          "allowFrom": ["+1111111111"]
        }
      }
    }
  }
}
```

Cada entrada de cuenta acepta todos los mismos campos que la configuración de nivel superior `connectors.signal`. Los campos de nivel superior actúan como valores predeterminados que las cuentas individuales pueden sobrescribir.

<div id="validation">

## Validación

</div>

- Cuando `dmPolicy` es `"open"`, el arreglo `allowFrom` debe incluir `"*"`.
- `startupTimeoutMs` debe estar entre 1000 y 120000 (1-120 segundos).

<div id="related">

## Relacionado

</div>

- [Referencia del plugin de Signal](/es/plugin-registry/platform/signal)
- [Descripción general de conectores](/es/guides/connectors)
- [Referencia de configuración](/es/configuration)
