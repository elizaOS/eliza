---
title: Conector de iMessage
sidebarTitle: iMessage
description: Conecta tu agente a iMessage usando el paquete @elizaos/plugin-imessage.
---

Conecta tu agente a iMessage para chats privados y conversaciones grupales en macOS.

<div id="overview">
## Descripción general
</div>

El conector de iMessage es un plugin externo de elizaOS que conecta tu agente con iMessage y SMS en macOS. Accede directamente a la base de datos nativa de iMessage y soporta conectividad con hosts remotos vía SSH. Se habilita automáticamente por el runtime cuando se detecta una ruta CLI en la configuración del conector.

<div id="package-info">
## Información del paquete
</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-imessage` |
| Clave de configuración | `connectors.imessage` |
| Activación automática | `cliPath` es verdadero en la configuración del conector |

<div id="prerequisites">
## Requisitos previos
</div>

- macOS con iMessage configurado e iniciado sesión
- Acceso completo al disco otorgado a la terminal o aplicación que ejecuta Eliza (para acceso a la base de datos de chat en `~/Library/Messages/chat.db`)
- Una herramienta CLI para acceso a iMessage (p. ej., `imessage-exporter`)

<div id="minimal-configuration">
## Configuración mínima
</div>

En `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "service": "auto",
      "dmPolicy": "pairing"
    }
  }
}
```

<div id="disabling">
## Desactivación
</div>

Para desactivar explícitamente el conector incluso cuando hay una ruta CLI presente:

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">
## Mecanismo de activación automática
</div>

El módulo `plugin-auto-enable.ts` verifica `connectors.imessage` en tu configuración. Si el campo `cliPath` es verdadero (y `enabled` no es explícitamente `false`), el runtime carga automáticamente `@elizaos/plugin-imessage`.

No se requiere ninguna variable de entorno para activar la activación automática — se controla completamente mediante el objeto de configuración del conector.

<div id="full-configuration-reference">
## Referencia completa de configuración
</div>

Todos los campos se definen bajo `connectors.imessage` en `eliza.json`.

<div id="core-fields">
### Campos principales
</div>

| Campo | Tipo | Predeterminado | Descripción |
|-------|------|----------------|-------------|
| `cliPath` | string | — | Ruta al ejecutable de la herramienta CLI de iMessage |
| `dbPath` | string | — | Ruta a la base de datos de iMessage (predeterminado: `~/Library/Messages/chat.db`) |
| `remoteHost` | string | — | Nombre de host del Mac remoto para acceso a iMessage vía SSH |
| `service` | `"imessage"` \| `"sms"` \| `"auto"` | — | Selección de servicio de mensajes. `"auto"` detecta el servicio apropiado |
| `region` | string | — | Configuración de región para formato de números de teléfono |
| `name` | string | — | Nombre de visualización de la cuenta |
| `enabled` | boolean | — | Activar/desactivar explícitamente |
| `capabilities` | string[] | — | Indicadores de capacidades |
| `includeAttachments` | boolean | — | Incluir adjuntos en los mensajes |
| `configWrites` | boolean | — | Permitir escritura de configuración desde eventos de iMessage |
| `dmPolicy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | Política de acceso a DMs. `"open"` requiere que `allowFrom` incluya `"*"` |
| `allowFrom` | (string\|number)[] | — | IDs de usuario permitidos para DMs |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Política de unión a grupos |
| `groupAllowFrom` | (string\|number)[] | — | IDs de usuario permitidos en grupos |
| `historyLimit` | integer >= 0 | — | Máximo de mensajes en contexto |
| `dmHistoryLimit` | integer >= 0 | — | Límite de historial para DMs |
| `dms` | object | — | Sobrecargas de historial por DM indexadas por ID de DM. Cada valor: `{historyLimit?: int}` |
| `textChunkLimit` | integer > 0 | — | Máximo de caracteres por fragmento de mensaje |
| `chunkMode` | `"length"` \| `"newline"` | — | Estrategia de división de mensajes largos |
| `mediaMaxMb` | integer > 0 | — | Tamaño máximo de archivo multimedia en MB |
| `markdown` | object | — | Renderizado de tablas: `tables` puede ser `"off"`, `"bullets"` o `"code"` |

<div id="streaming-configuration">
### Configuración de streaming
</div>

| Campo | Tipo | Predeterminado | Descripción |
|-------|------|----------------|-------------|
| `blockStreaming` | boolean | — | Desactivar streaming completamente |
| `blockStreamingCoalesce` | object | — | Configuración de coalescencia: `minChars`, `maxChars`, `idleMs` |

<div id="group-configuration">
### Configuración de grupos
</div>

Las configuraciones por grupo se definen bajo `groups.<group-id>`:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `requireMention` | boolean | Solo responder cuando se menciona con @ |
| `tools` | ToolPolicySchema | Política de acceso a herramientas |
| `toolsBySender` | object | Políticas de herramientas por remitente (indexadas por ID de remitente) |

<div id="heartbeat">
### Heartbeat
</div>

```json
{
  "connectors": {
    "imessage": {
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

El campo `accounts` permite ejecutar múltiples cuentas de iMessage desde un solo agente:

```json
{
  "connectors": {
    "imessage": {
      "accounts": {
        "personal": {
          "cliPath": "/usr/local/bin/imessage",
          "service": "imessage",
          "groups": {}
        },
        "work": {
          "cliPath": "/usr/local/bin/imessage",
          "remoteHost": "work-mac.local",
          "service": "auto",
          "groups": {}
        }
      }
    }
  }
}
```

Cada entrada de cuenta soporta los mismos campos que la configuración de nivel superior `connectors.imessage` (excluyendo el campo `accounts` en sí).

<div id="remote-host-access">
## Acceso a host remoto
</div>

Para conectar con iMessage en un Mac remoto vía SSH, establece el campo `remoteHost`:

```json
{
  "connectors": {
    "imessage": {
      "cliPath": "/usr/local/bin/imessage",
      "remoteHost": "mac-mini.local"
    }
  }
}
```

Asegúrate de que la autenticación SSH basada en claves esté configurada entre la máquina local y el host remoto.

<div id="troubleshooting">
## Solución de problemas
</div>

<div id="full-disk-access">
### Acceso completo al disco
</div>

Si la recuperación de mensajes falla, asegúrate de que el Acceso completo al disco esté otorgado:

1. Abre **Ajustes del Sistema > Privacidad y Seguridad > Acceso completo al disco**
2. Agrega la aplicación de terminal o el proceso de Eliza

<div id="database-path">
### Ruta de la base de datos
</div>

La base de datos predeterminada de iMessage está en `~/Library/Messages/chat.db`. Si usas una ubicación no estándar, establece `dbPath` explícitamente.

<div id="macos-only">
### Solo macOS
</div>

El conector de iMessage requiere macOS. No funcionará en Linux o Windows.

<div id="related">
## Relacionado
</div>

- [Referencia del plugin iMessage](/es/plugin-registry/platform/imessage)
- [Descripción general de conectores](/es/guides/connectors)
- [Referencia de configuración](/es/configuration)
