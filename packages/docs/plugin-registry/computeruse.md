---
title: "Computer Use Plugin"
sidebarTitle: "Computer Use"
description: "Computer use plugin for Eliza — screen control, mouse/keyboard automation, desktop screenshot, and GUI interaction."
---

The Computer Use plugin gives Eliza agents the ability to control the desktop — taking screenshots, moving the mouse, clicking, typing, and interacting with any GUI application running on the host machine.

**Package:** `@elizaos/plugin-computeruse`

## Overview

Computer use enables agents to operate the computer as a human would: viewing the screen, making decisions based on what they see, and interacting with the OS and applications through mouse and keyboard. This unlocks automation of any desktop application, not just those with APIs.

## Installation

```bash
eliza plugins install @elizaos/plugin-computeruse
```

## Enable via Features

```json
{
  "features": {
    "computeruse": true
  }
}
```

Or uncomment in `OPTIONAL_CORE_PLUGINS` in your configuration:

```json
{
  "plugins": {
    "allow": ["computeruse"]
  }
}
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `COMPUTER_USE_ENABLED` | No | Enable or disable computer use (default: disabled) |
| `COMPUTER_USE_SCREENSHOT_AFTER_ACTION` | No | Take a screenshot after each action |
| `COMPUTER_USE_ACTION_TIMEOUT_MS` | No | Timeout for individual actions in milliseconds |
| `COMPUTER_USE_APPROVAL_MODE` | No | Require human approval before actions |
| `COMPUTER_USE_BROWSER_HEADLESS` | No | Run the browser in headless mode |

## Platform Support

| Platform | Support |
|---------|---------|
| macOS | Full support |
| Linux (X11) | Full support |
| Linux (Wayland) | Partial support |
| Windows | Full support |

## Actions

| Action | Description |
|--------|-------------|
| `TAKE_SCREENSHOT` | Capture the current screen state |
| `MOUSE_MOVE` | Move the mouse cursor to coordinates |
| `MOUSE_CLICK` | Click at coordinates or on an element |
| `MOUSE_DRAG` | Click and drag from one point to another |
| `TYPE_TEXT` | Type text using the keyboard |
| `KEY_PRESS` | Press a keyboard shortcut or key combo |
| `SCROLL` | Scroll the mouse wheel |
| `FIND_ELEMENT` | Find a UI element by text or description |
| `OPEN_APPLICATION` | Launch an application by name |
| `GET_SCREEN_INFO` | Get screen resolution and layout |

## Vision Integration

Computer use works best with a vision-capable model. The workflow:

```
1. TAKE_SCREENSHOT
       ↓
2. Send to vision model (e.g., GPT-4o, Claude claude-sonnet-4-6)
       ↓
3. Model describes what is on screen
       ↓
4. Agent decides next action
       ↓
5. Execute action (click, type, etc.)
       ↓
6. Repeat
```

Configure a vision-capable model as the primary model:

```json
{
  "auth": {
    "profiles": {
      "default": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
      }
    }
  },
  "features": {
    "computeruse": true
  }
}
```

## Usage Examples

After the plugin is loaded:

> "Open Safari and navigate to hacker news"

> "Take a screenshot and tell me what application is open"

> "Click the Submit button on the form"

> "Type 'Hello world' in the terminal"

> "Open the System Preferences and take a screenshot of the Privacy settings"

## Coordinate System

Coordinates are in pixels from the top-left corner of the primary screen:

```
(0, 0) ──────────────→ x
  │
  │      screen
  │
  ↓ y
```

For multi-monitor setups, coordinates extend beyond the primary screen dimensions.

## Security Considerations

Computer use is a powerful capability. Consider:

- **Sandboxing**: The agent has full access to everything visible on screen and can interact with any application. Run in a dedicated VM or container for sensitive environments.
- **Rate limiting**: Add delays between actions to prevent runaway automation loops.
- **Approval gates**: Consider requiring human approval before executing destructive actions.
- **Logging**: Enable trajectory logging to audit agent actions.

## Trajectory Logging

Computer use sessions are automatically logged by the `trajectories` (a core plugin). Logs include screenshots and action sequences for debugging and RL training.

## Related

- [Browser Plugin](/plugin-registry/browser) — Web-only automation (sandboxed)
- [Shell Plugin](/plugin-registry/cron) — Shell command execution
- [Sandbox Guide](/guides/sandbox) — Security and isolation options

## CUA Operations Runbook

### Setup Checklist

1. Enable `features.computeruse` or include `computeruse` in `plugins.allow`.
2. Set `CUA_API_KEY` for the vision model provider (e.g., Anthropic or OpenAI).
3. If using a remote sandbox, set `CUA_HOST` and `CUA_SANDBOX_NAME`.
4. Ensure desktop/session permissions are granted for input and screenshot capture. On macOS, grant Accessibility and Screen Recording permissions. On Linux, ensure the X11/Wayland session allows programmatic input.
5. Pair with a vision-capable model (Claude with computer use, GPT-4o, etc.) and verify screenshot-to-action loop behavior.

### Failure Modes

**Screenshot and display:**

- Screenshot capture returns blank or fails:
  Check display server access. On macOS, confirm Screen Recording permission in System Settings > Privacy. On Linux, confirm `DISPLAY` is set and accessible. In Docker/headless environments, use Xvfb or a virtual framebuffer.
- Screenshot resolution mismatch:
  The CUA plugin captures at the display's native resolution. If the vision model receives oversized images, actions may target wrong coordinates. Configure display scaling or crop regions if needed.

**Vision model and action loop:**

- Vision model returns no actions:
  Confirm the model supports computer use / tool-use mode. Not all models can interpret screenshots and emit click/type actions. Check that the model ID in config is correct and the API key has access to computer use features.
- Actions target wrong screen coordinates:
  Coordinate mapping depends on screenshot resolution matching the actual display. If using display scaling (e.g., Retina), the plugin must account for the scale factor. Check `CUA_HOST` configuration for remote sandboxes.
- Agent performs repeated or unstable actions (click loops):
  Add approval gates via the agent's action policy. Enforce per-action rate limits in config. The trajectory logger captures action sequences — review logs to identify the loop trigger.
- Tool call errors (`tool_use_error`):
  The model may emit malformed tool calls. Check that the CUA plugin's tool schema matches what the model expects. Version mismatches between the plugin and the model API can cause schema drift.

**Sandbox and isolation:**

- Remote sandbox connection refused:
  Confirm `CUA_HOST` is reachable and the sandbox service is running. Check firewall rules and port access. The sandbox name (`CUA_SANDBOX_NAME`) must match an active session.
- Sandbox session expires:
  Remote sandboxes may have idle timeouts. If a long CUA task is interrupted, the session may need to be re-created. Check the sandbox provider's session lifecycle documentation.

**Cross-platform:**

- macOS: Requires Accessibility permission for keyboard/mouse input and Screen Recording for screenshots. Both must be granted to the terminal or agent process.
- Linux: Requires X11 access (`DISPLAY` env var) or Wayland equivalent. In containers, use Xvfb. `xdotool` or equivalent must be available for input simulation.
- Windows: Requires UIAccess or running as administrator for input to elevated windows. Screenshot APIs vary by Windows version.

### Recovery Procedures

1. **Stuck CUA session:** Kill the agent process and restart. The trajectory logger preserves the action log for debugging. Review `~/.eliza/agents/{agentId}/trajectories/` for the last action sequence.
2. **Permission denied after OS update:** macOS and Windows may revoke automation permissions after OS updates. Re-grant Accessibility and Screen Recording permissions.
3. **Coordinate drift after resolution change:** Restart the CUA session after any display resolution or scaling change. The plugin re-calibrates on session start.

### Verification Commands

```bash
# CUA integration and runtime boundary tests
bunx vitest run src/runtime/computeruse-integration.test.ts

# Runtime plugin loading (includes CUA short-id normalization)
bunx vitest run src/runtime/eliza.test.ts

bun run typecheck
```
