---
title: "Deep Linking"
sidebarTitle: "Deep Linking"
description: "Handle milady:// custom URL scheme links to open the desktop app and share content from external applications."
---

The Milady desktop app registers the `milady://` custom URL protocol so that external applications, browsers, and OS-level actions can open and communicate with the running app. Protocol registration is handled by the Electrobun deep linking integration and is set up during app initialization before the main window loads.

When an external application opens a `milady://` URL while the app is already running, Electrobun routes the URL to the native runtime. If the main window is not yet ready (still loading), incoming payloads are queued and flushed to the renderer once the `did-finish-load` event fires. Events are dispatched to the renderer as `milady:share-target` custom DOM events.

## Features

- `milady://share` URL handler for sharing text, URLs, and files from external apps or browsers
- File drag-and-drop via the desktop runtime `open-file` OS event (macOS)
- Payload queuing when the renderer is not yet ready
- DOM event dispatch (`milady:share-target`) for consumption by the web UI
- Fuzzy parameter parsing — `title`, `text`, `url`, and one or more `file` path parameters

## Configuration

No configuration file is required. The protocol is registered automatically at startup via the Electrobun integration. The URL scheme is `milady://` and cannot be changed without rebuilding the app.

**Share URL format:**

```
milady://share?title=Hello&text=Check+this+out&url=https://example.com
milady://share?file=/Users/alice/Documents/report.pdf
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `title` | No | Short title for the shared item |
| `text` | No | Body text to share |
| `url` | No | Web URL to attach |
| `file` | No (repeatable) | Absolute file path; can appear multiple times |

**Listening for share events in the renderer:**

```typescript
document.addEventListener("milady:share-target", (event: CustomEvent) => {
  const { title, text, url, files } = event.detail;
  // Handle the incoming share payload
  attachToCurrentConversation({ title, text, url, files });
});
```

## Related

- [Desktop App](/apps/desktop) — full desktop app architecture and embedded agent runtime
- [Native Modules](/apps/desktop/native-modules) — Canvas module that intercepts `milady://` URLs in auxiliary windows
- [Mobile App](/apps/mobile) — equivalent deep link handling on iOS (`AppDelegate`) and Android (`MainActivity`)
