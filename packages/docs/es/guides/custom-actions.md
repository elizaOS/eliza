---
title: Acciones Personalizadas
sidebarTitle: Acciones Personalizadas
description: Define capacidades creadas por el usuario con manejadores HTTP, shell y de código que amplían lo que el agente puede hacer.
---

Las acciones son la forma principal en que los agentes interactúan con el mundo. Representan capacidades discretas -- cosas que el agente puede hacer en respuesta al contexto de la conversación. Eliza incluye acciones integradas y proporciona un sistema para definir tus propias acciones personalizadas sin escribir código de plugin.

<div id="action-interface">

## Interfaz de Acción

</div>

En el runtime de elizaOS, una `Action` es un objeto con:

- **name** -- Identificador único que el runtime usa para seleccionar la acción (p. ej., `RESTART_AGENT`).
- **similes** -- Nombres alternativos que ayudan al agente a coincidir con la intención del usuario (p. ej., `REBOOT`, `RELOAD`).
- **description** -- Texto legible que el agente usa para decidir cuándo esta acción es apropiada.
- **validate** -- Función asíncrona que devuelve si la acción puede ejecutarse en el contexto actual.
- **handler** -- Función asíncrona que ejecuta la acción y devuelve los resultados.
- **parameters** -- Arreglo de definiciones de parámetros que describen las entradas aceptadas.
- **examples** -- Ejemplos de conversación opcionales para ayudar al agente a aprender cuándo usar la acción.

Cuando un usuario envía un mensaje, el runtime evalúa todas las acciones registradas. Si el agente determina que una acción coincide con la intención del usuario, extrae los parámetros de la conversación y llama al handler.

<div id="built-in-actions-reference">

## Referencia de Acciones Integradas

</div>

Eliza registra las siguientes acciones integradas desde `src/actions/` automáticamente en tiempo de ejecución.

<div id="agent-lifecycle">

### Ciclo de Vida del Agente

</div>

**RESTART_AGENT** -- Reinicia el proceso del agente de forma controlada. Detiene el runtime, reconstruye si los archivos fuente cambiaron, y relanza. Persiste una memoria de "Restarting...", devuelve la respuesta, y luego programa un reinicio después de un retraso de 1.5 segundos para que la respuesta pueda vaciarse. En modo CLI, sale con código 75 para el script ejecutor; en modo de runtime de escritorio, realiza un reinicio en caliente dentro del proceso. El parámetro opcional `reason` se registra para diagnósticos.

<div id="plugin-management">

### Gestión de Plugins

</div>

Estas acciones proporcionan un flujo completo de trabajo de eyección de plugins. "Eyectar" clona el código fuente de un plugin localmente para que el runtime cargue tu copia local en lugar del paquete npm.

| Action | Descripción | Parámetros Clave |
|--------|-------------|-----------------|
| `EJECT_PLUGIN` | Clona el código fuente de un plugin localmente para que las ediciones anulen la versión npm. Activa reinicio. | `pluginId` (requerido) |
| `SYNC_PLUGIN` | Obtiene y fusiona commits upstream en un plugin eyectado. Reporta conflictos si los hay. | `pluginId` (requerido) |
| `REINJECT_PLUGIN` | Elimina la copia eyectada del plugin para que el runtime vuelva a npm. Activa reinicio. | `pluginId` (requerido) |
| `LIST_EJECTED_PLUGINS` | Lista todos los plugins eyectados con nombre, rama y ruta local. | Ninguno |

<div id="core-ejection">

### Eyección del Núcleo

</div>

Similar a la eyección de plugins pero para el propio framework núcleo de elizaOS.

| Action | Descripción |
|--------|-------------|
| `EJECT_CORE` | Clona el código fuente de `@elizaos/core` localmente para que las ediciones anulen el paquete npm. Activa reinicio. |
| `SYNC_CORE` | Sincroniza un checkout eyectado del núcleo con upstream y lo reconstruye. Reporta el conteo de commits upstream o conflictos. |
| `REINJECT_CORE` | Elimina el código fuente eyectado del núcleo para que el runtime vuelva al paquete npm `@elizaos/core`. Activa reinicio. |
| `CORE_STATUS` | Muestra si `@elizaos/core` se ejecuta desde npm o desde código fuente eyectado, con versión y hash de commit. |

<div id="communication">

### Comunicación

</div>

**MESSAGE** -- Envía un mensaje a un usuario o sala en una plataforma/servicio específico. Requiere `targetType` (`user` o `room`), `source` (nombre del servicio como `telegram`), `target` (ID de entidad/sala), y `text`. Busca el servicio mediante `runtime.getService()` y llama al método de envío apropiado.

<div id="media-generation">

### Generación de Medios

</div>

| Action | Descripción | Parámetros Requeridos |
|--------|-------------|----------------------|
| `GENERATE_MEDIA` | Genera imagen, video o audio a partir de un prompt de texto. Soporta opciones de imagen, video y audio; usa `mediaType` para forzar `image`, `video` o `audio`. | `prompt` |
| `ANALYZE_IMAGE` | Analiza una imagen usando visión IA. Acepta `imageUrl` o `imageBase64` con un `prompt` de análisis opcional. | `imageUrl` o `imageBase64` |

Todas las acciones de medios usan el proveedor configurado (Eliza Cloud por defecto, o FAL/OpenAI/Google/Anthropic).

<div id="system">

### Sistema

</div>

| Action | Descripción |
|--------|-------------|
| `PLAY_EMOTE` | Reproduce una animación de emote en el avatar. Busca el emote en el catálogo y hace POST a la API local. |
| `INSTALL_PLUGIN` | Instala un plugin desde el registro mediante `POST /api/plugins/install`. Se reinicia automáticamente para cargarlo. |
| `SHELL_COMMAND` | Ejecuta un comando de shell mediante `POST /api/terminal/run`. La salida se transmite por WebSocket. |
| `LOG_LEVEL` | Establece el nivel de log por sala para la sesión actual (`trace`, `debug`, `info`, `warn`, `error`). |

<div id="custom-actions">

## Acciones Personalizadas

</div>

Las acciones personalizadas son capacidades definidas por el usuario en tu configuración `eliza.json`. Te permiten conectar APIs externas, ejecutar comandos de shell o ejecutar JavaScript en línea -- todo presentado como acciones de primera clase que el agente puede invocar durante las conversaciones.

<div id="handler-types">

### Tipos de Handler

</div>

Cada acción personalizada tiene un `handler` que especifica cómo se ejecuta:

<CodeGroup>
```json http
{
  "type": "http",
  "method": "POST",
  "url": "https://api.example.com/data/{{query}}",
  "headers": {
    "Authorization": "Bearer sk-xxx",
    "Content-Type": "application/json"
  },
  "bodyTemplate": "{\"search\": \"{{query}}\"}"
}
```

```json shell
{
  "type": "shell",
  "command": "curl -s https://api.example.com/status?q={{query}}"
}
```

```json code
{
  "type": "code",
  "code": "const res = await fetch('https://api.example.com/data/' + params.id); return await res.text();"
}
```
</CodeGroup>

**`http`** -- Realiza una solicitud HTTP. Los marcadores de posición de parámetros (`{{paramName}}`) en la URL se codifican con URI; los marcadores en la plantilla del cuerpo se dejan sin procesar para contextos JSON. Campos: `method`, `url`, `headers`, `bodyTemplate`.

<Warning>
Los handlers HTTP incluyen protección SSRF que bloquea solicitudes a direcciones de red privadas/internas (localhost, link-local, rangos RFC-1918, endpoints de metadatos en la nube). La resolución DNS se verifica para prevenir bypass por alias. Las redirecciones se bloquean por completo.
</Warning>

**`shell`** -- Ejecuta un comando de shell mediante la API de terminal local. Los valores de los parámetros se escapan automáticamente para prevenir inyección. Se ejecuta a través de `POST /api/terminal/run`.

**`code`** -- Ejecuta JavaScript en línea en un contexto VM de Node.js aislado (`vm.runInNewContext()`). Solo `params` y `fetch` están expuestos en el sandbox -- sin acceso a `require`, `import`, `process` ni `global`. Tiempo límite de 30 segundos.

<div id="customactiondef-schema">

### Esquema CustomActionDef

</div>

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `id` | `string` | Sí | Identificador único para la acción |
| `name` | `string` | Sí | Nombre de la acción utilizado por el agente para invocarla |
| `description` | `string` | Sí | Descripción legible de lo que hace la acción |
| `similes` | `string[]` | No | Nombres/activadores alternativos para la acción |
| `parameters` | `Array<{name, description, required}>` | Sí | Definiciones de parámetros |
| `handler` | `CustomActionHandler` | Sí | Uno de los objetos handler `http`, `shell` o `code` |
| `enabled` | `boolean` | Sí | Si la acción está activa |
| `createdAt` | `string` | Sí | Marca de tiempo ISO de creación |
| `updatedAt` | `string` | Sí | Marca de tiempo ISO de la última actualización |

<div id="defining-custom-actions">

### Definir Acciones Personalizadas

</div>

Agrega acciones personalizadas al arreglo `customActions` en tu `eliza.json`:

```json
{
  "customActions": [
    {
      "id": "weather-check",
      "name": "CHECK_WEATHER",
      "description": "Check the current weather for a given city",
      "similes": ["WEATHER", "GET_WEATHER", "FORECAST"],
      "parameters": [
        {
          "name": "city",
          "description": "The city name to check weather for",
          "required": true
        }
      ],
      "handler": {
        "type": "http",
        "method": "GET",
        "url": "https://wttr.in/{{city}}?format=3"
      },
      "enabled": true,
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:00:00Z"
    }
  ]
}
```

<div id="action-discovery-and-registration">

### Descubrimiento y Registro de Acciones

</div>

**Carga al inicio:** Durante la inicialización del plugin, `loadCustomActions()` lee `eliza.json`, filtra solo las definiciones con `enabled`, y convierte cada una en una `Action` de elizaOS mediante `defToAction()`. La conversión construye un handler asíncrono basado en el tipo de handler, mapea los parámetros al formato elizaOS (todos tipados como `string`), y establece `validate: async () => true`.

**Registro en vivo:** Registra nuevas acciones en tiempo de ejecución sin reiniciar usando `registerCustomActionLive(def)`. Esto convierte la definición usando el mismo pipeline `defToAction()` y llama a `runtime.registerAction()` para hacerla disponible inmediatamente. Devuelve la `Action` creada o `null` si no hay runtime disponible.

**Pruebas:** La función `buildTestHandler(def)` crea un handler temporal para pruebas sin registrar. Devuelve una función que acepta parámetros y retorna `{ ok: boolean; output: string }`.

```typescript
import { buildTestHandler } from './runtime/custom-actions';

const testHandler = buildTestHandler(myActionDef);
const result = await testHandler({ city: 'London' });
// result: { ok: true, output: 'London: +12°C' }
```

<div id="creating-actions-in-plugins">

## Crear Acciones en Plugins

</div>

Más allá de las acciones personalizadas definidas por configuración, puedes crear acciones como parte de un plugin implementando la interfaz `Action` directamente.

<Steps>

<div id="define-the-action">

### Definir la Acción

</div>

```typescript
import type { Action, HandlerOptions } from '@elizaos/core';

export const myAction: Action = {
  name: 'MY_CUSTOM_ACTION',
  similes: ['MY_ACTION', 'DO_THING'],
  description: 'Describe what this action does so the agent knows when to use it.',

  validate: async (runtime, message, state) => {
    // Return true if this action can run in the current context.
    return true;
  },

  handler: async (runtime, message, state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters;
    const input = typeof params?.input === 'string' ? params.input.trim() : '';

    if (!input) {
      return { text: 'I need an input parameter.', success: false };
    }

    const result = await doSomething(input);
    return {
      text: `Done: ${result}`,
      success: true,
      data: { input, result },
    };
  },

  parameters: [
    {
      name: 'input',
      description: 'The input value for this action',
      required: true,
      schema: { type: 'string' as const },
    },
  ],
};
```

<div id="write-the-validation-function">

### Escribir la Función de Validación

</div>

Patrones comunes de validación:

```typescript
// Siempre disponible
validate: async () => true,

// Solo cuando un servicio específico está cargado
validate: async (runtime) => {
  return runtime.getService('myservice') !== null;
},

// Solo para ciertos usuarios
validate: async (runtime, message) => {
  const adminIds = ['user-123', 'user-456'];
  return adminIds.includes(message.entityId);
},
```

<div id="write-the-handler-function">

### Escribir la Función Handler

</div>

El handler recibe `runtime` (IAgentRuntime), `message` (Memory), `state` (State | undefined), y `options` (convertido a `HandlerOptions` para acceso a parámetros). Debe devolver un objeto con `text` (string) y `success` (boolean). Campos opcionales: `data` (metadatos) y `attachments` (archivos multimedia).

<div id="register-in-a-plugin">

### Registrar en un Plugin

</div>

```typescript
import type { Plugin } from '@elizaos/core';
import { myAction } from './actions/my-action';

export const myPlugin: Plugin = {
  name: 'my-plugin',
  description: 'My custom plugin',
  actions: [myAction],
};
```

</Steps>

<div id="action-execution-flow">

## Flujo de Ejecución de Acciones

</div>

Cuando el agente procesa un mensaje, las acciones se evalúan en este orden:

1. **Coincidencia de intención** -- El runtime evalúa los nombres, similes y descripciones de todas las acciones registradas contra el contexto de la conversación.
2. **Validación** -- Se llama a la función `validate()` de la acción seleccionada. Si devuelve `false`, la acción se omite.
3. **Extracción de parámetros** -- El runtime extrae los valores de los parámetros de la conversación basándose en las definiciones de `parameters` de la acción.
4. **Ejecución del handler** -- El `handler()` de la acción se ejecuta con los parámetros extraídos.
5. **Entrega de respuesta** -- El valor de retorno del handler (texto, adjuntos, datos) se entrega de vuelta al usuario.

<div id="best-practices">

## Mejores Prácticas

</div>

<Info>

**Nombres:** Usa SCREAMING_SNAKE_CASE para los nombres de las acciones. Mantén los nombres cortos y agrega similes relevantes para mejorar la coincidencia de intención.

**Descripciones:** El agente usa la descripción para decidir cuándo invocar tu acción. Escribe descripciones claras y específicas que expliquen tanto lo que hace la acción como cuándo debe usarse.

**Valida defensivamente:** Siempre verifica los parámetros requeridos en el handler y devuelve un mensaje de error útil si faltan, incluso si `validate()` devuelve `true`.

**Mantén los handlers rápidos:** Para operaciones de larga duración, devuelve un mensaje de estado inmediatamente y usa WebSocket o polling para actualizaciones de progreso.

**Retornos estructurados:** Siempre incluye `success: boolean`. Usa `data` para metadatos legibles por máquina que otras acciones o la UI puedan consumir.

</Info>
