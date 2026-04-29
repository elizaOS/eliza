---
title: "Vision Plugin"
sidebarTitle: "Vision"
description: "Vision plugin for Milady — image understanding and visual analysis capabilities for agents."
---

The Vision plugin gives Milady agents the ability to understand and analyze images, enabling visual reasoning in conversations.

**Package:** `@elizaos/plugin-vision`

## Installation

```bash
milady plugins install @elizaos/plugin-vision
```

## Enable via Features

```json
{
  "features": {
    "vision": true
  }
}
```

**Note:** This plugin requires the `@tensorflow/tfjs-node` native addon. On systems without native build tools, set `MILADY_NO_VISION_DEPS=1` to skip installation of optional vision dependencies.

## Configuration

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `CAMERA_NAME` | string | — | Camera name to search for (lowercase partial match) |
| `PIXEL_CHANGE_THRESHOLD` | number | 50 | Percentage of pixels that must change to trigger a VLM update |

Set these in your plugin config or as environment variables.

## Features

- Image understanding and description
- Visual analysis of screenshots and photos
- Camera integration with change detection
- Feature-gated — only loaded when explicitly enabled

## Related

- [Browser Plugin](/plugin-registry/browser) — Web automation with screenshot capture
- [Computer Use Plugin](/plugin-registry/computeruse) — Full desktop automation
- [Image Generation Plugin](/plugin-registry/image-generation) — Generate images
