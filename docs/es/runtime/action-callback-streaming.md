---
title: Callbacks de acción y transmisión SSE
description: Por qué Eliza reemplaza (no concatena) el texto de los callbacks de acción en el chat del panel, y cómo coincide con los mensajes progresivos al estilo Discord.
---

<div id="action-callbacks-and-sse-streaming">
# Callbacks de acción y transmisión SSE
</div>

El chat del panel de Eliza usa **Server-Sent Events (SSE)** para transmitir la respuesta del asistente. Dos tipos diferentes de texto llegan por el mismo flujo:

1. **Tokens del LLM** — la respuesta transmitida del modelo (`onStreamChunk`).
2. **Callbacks de acción** — texto devuelto por `HandlerCallback` mientras se ejecuta una acción (p. ej. `PLAY_AUDIO`, flujos de billetera, fallbacks de habilidades de Binance).

Esta página explica **cómo se fusionan** y **por qué** ese diseño coincide con plataformas como Discord y Telegram.

---

<div id="the-problem-we-solved">
## El problema que resolvimos
</div>

En **Discord**, `@elizaos/plugin-discord` usa un **mensaje progresivo**: se crea un mensaje en el canal y luego se **edita en el lugar** a medida que llegan las actualizaciones de estado ("Looking up track…", "Searching…", "Now playing: …").

En **web**, cada `callback({ text })` se procesaba anteriormente a través de la misma ruta de fusión que los fragmentos transmitidos arbitrarios. Las cadenas de estado no relacionadas no comparten un prefijo entre sí, por lo que la heurística de fusión a menudo las **concatenaba**:

```text
🔍 Looking up track...🔍 Searching for track...✨ Setting up playback...Now playing: **Song**
```

Eso es correcto para **deltas de tokens** que extienden la misma respuesta, pero incorrecto para **estados sucesivos** que deberían **reemplazar** el estado anterior.

**Por qué importa:** Los usuarios esperan **actualizaciones en vivo, en el lugar** (estilo web2 en tiempo real), no una pila creciente de fragmentos de estado. Los plugins no deberían necesitar un segundo transporte (WebSocket, eventos personalizados) solo para lograr paridad con Discord.

---

<div id="the-eliza-behavior">
## El comportamiento de Eliza
</div>

Dentro de `generateChatResponse` (`eliza/packages/agent/src/api/chat-routes.ts`):

- Los **fragmentos del LLM** siguen usando semántica de **adición** vía `appendIncomingText` → `resolveStreamingUpdate` → `onChunk`.
- Los **callbacks de acción** usan **`replaceCallbackText`**:
  - En el **primer** callback de un turno, el servidor toma una instantánea de lo que ya se había transmitido (`preCallbackText` — generalmente el texto parcial o final del LLM).
  - Cada callback **posterior** establece la respuesta visible como:

    `preCallbackText + "\n\n" + latestCallbackText`

  - Así que el **segmento del callback** se **reemplaza** cada vez; el prefijo del LLM se preserva.

La capa HTTP emite una **instantánea** (`onSnapshot`) para que el evento SSE contenga el **nuevo** `fullText` completo. El cliente ya trata `fullText` como autoritativo y **reemplaza** el texto de la burbuja del asistente — no se requirió ningún cambio en la UI.

**Por qué instantánea:** El parser SSE del frontend usa `fullText` cuando está presente; reemplazar todo el mensaje del asistente es O(1) para la UI y coincide mentalmente con "editar el cuerpo del mensaje".

**Por qué rutas separadas para LLM vs callback:** La transmisión del LLM es genuinamente incremental (adición). El progreso de acciones es **reemplazo de estado** (el último estado gana). Mezclar ambos a través de una sola función de fusión difuminaba esas semánticas.

---

<div id="plugin-contract-unchanged">
## Contrato del plugin (sin cambios)
</div>

Los plugins deben seguir usando la forma `HandlerCallback` de **elizaOS**:

```typescript
await callback({ text: "🔍 Searching…", source: message.content.source });
await callback({ text: "Now playing: **Track**", source: message.content.source });
```

Sin campos adicionales, sin APIs específicas de Eliza, sin adjuntos al runtime. Helpers como `ProgressiveMessage` en `plugin-music-player` siguen siendo una capa delgada sobre `callback`.

**Por qué preservar el contrato:** Discord y otros conectores ya dependen de esta API; el trabajo de Eliza es interpretar callbacks repetidos correctamente en la ruta del **chat API**, no bifurcar la superficie del plugin.

---

<div id="where-it-applies">
## Dónde se aplica
</div>

`replaceCallbackText` está conectado para:

- El callback de acción principal de `messageService.handleMessage`.
- `executeFallbackParsedActions` (recuperación de acciones parseadas).
- Despacho directo de habilidades de Binance (`maybeHandleDirectBinanceSkillRequest`).
- Fallback de ejecución de billetera y rutas similares que invocan acciones con callbacks.

**No** se usa para `onStreamChunk` — ese permanece solo de adición.

---

<div id="related-code-and-docs">
## Código y documentación relacionados
</div>

- **Implementación:** `eliza/packages/agent/src/api/chat-routes.ts` — `replaceCallbackText`, `preCallbackText`.
- **Helper de ejemplo:** `plugins/plugin-music-player/src/utils/progressiveMessage.ts`.
- **Transmisión en UI:** [Panel — Chat](/es/dashboard/chat) (SSE / indicador de escritura).
- **Registro de cambios:** [Registro de cambios](/es/changelog) — busca "action callback" o la fecha de publicación.

---

<div id="future--roadmap">
## Futuro / hoja de ruta
</div>

Posibles seguimientos (no enviados como requisitos aquí):

- **Metadatos** opcionales en el contenido del callback para distinguir "adición" vs "reemplazo" para plugins exóticos (solo si aparece un caso de uso real).
- **Persistencia** de estados intermedios (hoy el texto del turno persistido sigue las reglas normales de persistencia del chat).

Consulta `docs/roadmap.md` en el repositorio para la dirección general del producto.
