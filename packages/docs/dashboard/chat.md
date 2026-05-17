---
title: Chat
sidebarTitle: Chat
description: The core messaging interface for interacting with your Eliza agent — voice chat, 3D avatar, conversations, and autonomous monitoring.
---

The Chat tab is the default landing view of the dashboard. It provides the core messaging interface through the `ChatView` component, with a three-column layout: Conversations Sidebar on the left, the Chat View in the center, and the Autonomous Panel on the right.

## Message Area

Messages render through the `MessageContent` component, which supports:

- **Plain text** — standard chat messages with line breaks preserved.
- **Inline plugin config** — `[CONFIG:pluginId]` markers in agent responses render as interactive plugin configuration forms using `ConfigRenderer`.
- **UI Spec rendering** — fenced JSON code blocks containing UiSpec objects render as interactive UI elements via `UiRenderer`.
- **Code blocks** — syntax-highlighted fenced code blocks.
- **Streaming** — agent responses stream in token-by-token with a visible typing indicator. The `chatFirstTokenReceived` flag tracks when the first token arrives.
- **Action progress (replace semantics)** — When an action calls its callback several times (same idea as Discord progressive messages), the API sends **snapshot** SSE updates so the **latest** callback text replaces the previous one after the model’s streamed prefix, instead of concatenating every status line into one blob. **Why:** Real-time status should feel like **live edits**, not appended noise. See [Action callbacks and SSE streaming](/runtime/action-callback-streaming).

## Input Area

The chat input area sits at the bottom of the view:

- **Auto-resizing textarea** — grows from 38 px to a maximum of 200 px as you type.
- **Image attachments** — attach images via the file picker button, drag-and-drop onto the chat area, or paste from clipboard. Pending images display as thumbnails above the input.
- **File drops** — drag and drop files into the chat area to share them with the agent. A visual drop zone indicator appears during drag.
- **Send / Stop** — the send button submits the message; while the agent is responding, a stop button appears to cancel generation.

## Voice Chat

Built-in voice chat powered by ElevenLabs or browser TTS/STT:

- Voice configuration loads automatically from the agent's config on mount.
- The `useVoiceChat` hook manages the microphone toggle, agent voice playback, and the speaking state that drives avatar lip-sync.
- Voice config changes in Settings or Character views are synchronized in real-time via a `eliza:voice-config-updated` custom DOM event.

## VRM 3D Avatar

A live 3D avatar rendered with Three.js and `@pixiv/three-vrm`:

- The avatar responds to conversation with idle animations and emotes.
- Select from 8 built-in VRM models via the `selectedVrmIndex` state.
- Toggle avatar visibility and agent voice mute via the two control buttons in the Autonomous Panel's Chat Controls section.

## Conversations Sidebar

The `ConversationsSidebar` component manages multiple conversations:

- **Conversation list** — sorted by most recently updated. Each entry shows the title, a relative timestamp (e.g., "5m ago", "2d ago"), and an unread indicator for conversations with new messages.
- **Create new** — a "New Chat" button at the top creates a fresh conversation thread.
- **Rename** — double-click a conversation title to enter inline edit mode. Press Enter to save or Escape to cancel.
- **Delete** — each conversation has a delete button that removes the thread permanently.
- **Unread tracking** — the `unreadConversations` set tracks which conversations have new messages the user has not yet viewed.

## Autonomous Panel

Displayed on the right side of the Chat tab, the `AutonomousPanel` component provides real-time visibility into autonomous operations:

- **Current state** — shows the latest "Thought" (from assistant/evaluator streams) and latest "Action" (from action/tool/provider streams).
- **Event Stream** — a collapsible, reverse-chronological feed of the last 120 events, color-coded by type:

| Event Type | Color |
|------------|-------|
| Heartbeat events | Accent |
| Error events | Red (danger) |
| Action, tool, provider events | Green (success) |
| Assistant thoughts | Accent |
| Other events | Muted gray |

- **Workbench Tasks** — active tasks the agent is working on, displayed as a checklist.
- **Triggers** — scheduled triggers (interval, cron, one-time) with their type, enabled status, and run count.
- **Todos** — task items tracked by the agent, displayed as a checklist.
- **Chat Controls** — at the bottom, avatar visibility toggle and agent voice mute toggle, plus a VRM avatar preview window (260-420 px tall depending on viewport).

## Emote Picker

Trigger VRM avatar emotes with the keyboard shortcut **Cmd+E** (macOS) or **Ctrl+E** (Windows/Linux). The picker provides 29 emotes across 6 categories:

| Category | Emotes |
|----------|--------|
| **Greeting** | Wave, Kiss |
| **Emotion** | Crying, Sorrow, Rude Gesture, Looking Around |
| **Dance** | Dance Happy, Dance Breaking, Dance Hip Hop, Dance Popping |
| **Combat** | Hook Punch, Punching, Firing Gun, Sword Swing, Chopping, Spell Cast, Range, Death |
| **Idle** | Idle, Talk, Squat, Fishing |
| **Movement** | Float, Jump, Flip, Run, Walk, Crawling, Fall |

Each emote is represented by a clickable icon button. Categories are displayed as filterable tabs within the picker.

## Context Menu

Right-click messages to access a context menu for saving commands or performing custom actions.
