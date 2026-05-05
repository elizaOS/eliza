---
title: Chat
sidebarTitle: Chat
description: La interfaz principal de mensajería para interactuar con tu agente Eliza — chat de voz, avatar 3D, conversaciones y monitoreo autónomo.
---

La pestaña Chat es la vista predeterminada de inicio del panel de control. Proporciona la interfaz principal de mensajería a través del componente `ChatView`, con un diseño de tres columnas: la barra lateral de conversaciones a la izquierda, la vista de chat en el centro y el panel autónomo a la derecha.

<div id="message-area">
## Área de mensajes
</div>

Los mensajes se renderizan a través del componente `MessageContent`, que soporta:

- **Texto plano** — mensajes de chat estándar con saltos de línea preservados.
- **Configuración de plugin en línea** — los marcadores `[CONFIG:pluginId]` en las respuestas del agente se renderizan como formularios interactivos de configuración de plugin usando `ConfigRenderer`.
- **Renderizado de UI Spec** — los bloques de código JSON delimitados que contienen objetos UiSpec se renderizan como elementos de UI interactivos a través de `UiRenderer`.
- **Bloques de código** — bloques de código delimitados con resaltado de sintaxis.
- **Transmisión** — las respuestas del agente se transmiten token por token con un indicador de escritura visible. La bandera `chatFirstTokenReceived` rastrea cuándo llega el primer token.
- **Progreso de acción (semántica de reemplazo)** — Cuando una acción llama a su callback varias veces (la misma idea que los mensajes progresivos de Discord), la API envía actualizaciones SSE de tipo **instantánea** para que el **último** texto del callback reemplace al anterior después del prefijo transmitido del modelo, en lugar de concatenar cada línea de estado en un bloque. **Por qué:** El estado en tiempo real debería sentirse como **ediciones en vivo**, no como ruido acumulado. Consulta [Callbacks de acción y transmisión SSE](/es/runtime/action-callback-streaming).

<div id="input-area">
## Área de entrada
</div>

El área de entrada del chat está en la parte inferior de la vista:

- **Área de texto auto-redimensionable** — crece de 38 px a un máximo de 200 px mientras escribes.
- **Adjuntos de imágenes** — adjunta imágenes mediante el botón de selección de archivos, arrastra y suelta en el área de chat, o pega desde el portapapeles. Las imágenes pendientes se muestran como miniaturas sobre la entrada.
- **Soltar archivos** — arrastra y suelta archivos en el área de chat para compartirlos con el agente. Un indicador visual de zona de soltar aparece durante el arrastre.
- **Enviar / Detener** — el botón de enviar envía el mensaje; mientras el agente está respondiendo, aparece un botón de detener para cancelar la generación.

<div id="voice-chat">
## Chat de voz
</div>

Chat de voz integrado con ElevenLabs o TTS/STT del navegador:

- La configuración de voz se carga automáticamente desde la configuración del agente al montar.
- El hook `useVoiceChat` gestiona el toggle del micrófono, la reproducción de voz del agente y el estado de habla que controla el lip-sync del avatar.
- Los cambios de configuración de voz en Ajustes o vistas de Personaje se sincronizan en tiempo real a través de un evento DOM personalizado `eliza:voice-config-updated`.

<div id="vrm-3d-avatar">
## Avatar 3D VRM
</div>

Un avatar 3D en vivo renderizado con Three.js y `@pixiv/three-vrm`:

- El avatar responde a la conversación con animaciones inactivas y emotes.
- Selecciona entre 8 modelos VRM integrados a través del estado `selectedVrmIndex`.
- Alterna la visibilidad del avatar y el silencio de voz del agente mediante los dos botones de control en la sección de Controles de Chat del Panel Autónomo.

<div id="conversations-sidebar">
## Barra lateral de conversaciones
</div>

El componente `ConversationsSidebar` gestiona múltiples conversaciones:

- **Lista de conversaciones** — ordenada por la más recientemente actualizada. Cada entrada muestra el título, una marca de tiempo relativa (p. ej., "hace 5m", "hace 2d") y un indicador de no leído para conversaciones con nuevos mensajes.
- **Crear nueva** — un botón "Nuevo Chat" en la parte superior crea un nuevo hilo de conversación.
- **Renombrar** — haz doble clic en el título de una conversación para entrar en modo de edición en línea. Presiona Enter para guardar o Escape para cancelar.
- **Eliminar** — cada conversación tiene un botón de eliminar que borra el hilo permanentemente.
- **Seguimiento de no leídos** — el conjunto `unreadConversations` rastrea qué conversaciones tienen nuevos mensajes que el usuario aún no ha visto.

<div id="autonomous-panel">
## Panel autónomo
</div>

Mostrado en el lado derecho de la pestaña Chat, el componente `AutonomousPanel` proporciona visibilidad en tiempo real de las operaciones autónomas:

- **Estado actual** — muestra el último "Pensamiento" (de flujos de asistente/evaluador) y la última "Acción" (de flujos de acción/herramienta/proveedor).
- **Flujo de eventos** — un feed colapsable, en orden cronológico inverso, de los últimos 120 eventos, codificados por color según el tipo:

| Tipo de evento | Color |
|------------|-------|
| Eventos de heartbeat | Acento |
| Eventos de error | Rojo (peligro) |
| Eventos de acción, herramienta, proveedor | Verde (éxito) |
| Pensamientos del asistente | Acento |
| Otros eventos | Gris atenuado |

- **Tareas del Workbench** — tareas activas en las que el agente está trabajando, mostradas como una lista de verificación.
- **Triggers** — triggers programados (intervalo, cron, una vez) con su tipo, estado habilitado y conteo de ejecuciones.
- **Tareas pendientes** — elementos de tarea rastreados por el agente, mostrados como una lista de verificación.
- **Controles de Chat** — en la parte inferior, toggle de visibilidad del avatar y toggle de silencio de voz del agente, más una ventana de vista previa del avatar VRM (260-420 px de alto dependiendo del viewport).

<div id="emote-picker">
## Selector de emotes
</div>

Activa emotes del avatar VRM con el atajo de teclado **Cmd+E** (macOS) o **Ctrl+E** (Windows/Linux). El selector ofrece 29 emotes en 6 categorías:

| Categoría | Emotes |
|----------|--------|
| **Greeting** | Wave, Kiss |
| **Emotion** | Crying, Sorrow, Rude Gesture, Looking Around |
| **Dance** | Dance Happy, Dance Breaking, Dance Hip Hop, Dance Popping |
| **Combat** | Hook Punch, Punching, Firing Gun, Sword Swing, Chopping, Spell Cast, Range, Death |
| **Idle** | Idle, Talk, Squat, Fishing |
| **Movement** | Float, Jump, Flip, Run, Walk, Crawling, Fall |

Cada emote está representado por un botón con icono al que se puede hacer clic. Las categorías se muestran como pestañas filtrables dentro del selector.

<div id="context-menu">
## Menú contextual
</div>

Haz clic derecho en los mensajes para acceder a un menú contextual para guardar comandos o realizar acciones personalizadas.
