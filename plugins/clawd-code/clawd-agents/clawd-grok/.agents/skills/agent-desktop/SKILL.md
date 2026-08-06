---
name: agent-desktop
description: Use the built-in `Computer` sub-agent with `agent-desktop` for macOS desktop automation. Apply when a task needs application launching, accessibility snapshots, stable element refs, window focusing, semantic clicks/typing, or visual confirmation outside the browser sandbox.
---

# agent-desktop

Use this skill when the task involves the host macOS desktop rather than repository files, shell output, or browser-only verification.

This project uses `agent-desktop` on the host. Prefer the built-in `Computer` sub-agent for these tasks instead of trying to drive the desktop with plain shell commands.

## When to use it

- The user wants to inspect or interact with a native macOS application.
- The task needs app launch, window focus, accessibility snapshots, semantic element refs, clicks, typing, keypresses, or scrolling.
- A browser-only workflow is not enough, or the target is not a web page.

## Requirements

- `agent-desktop` must be installed and its native binary available.
- On macOS, the terminal app running `grok` needs Accessibility permission.
- Refs from `computer_snapshot` are only valid until the next snapshot.

## Preferred flow

1. Delegate to `task` with `agent: "computer"` unless the current agent already has the `computer_*` tools and the task is tiny.
2. Use `computer_launch`, `computer_list_windows`, or `computer_focus_window` to get the target app/window ready.
3. Start with `computer_snapshot`.
4. Pick one ref-based action.
5. After any UI transition, snapshot again before reusing refs.

## Tool guidance

- `computer_snapshot`: primary observation tool; prefer `interactive_only`.
- `computer_click`: use `ref` values from the latest snapshot whenever possible.
- `computer_type`: requires a target ref and is preferred over coordinate typing.
- `computer_press`: use for shortcuts and special keys such as `Enter`, `Tab`, `cmd+space`, or `cmd+k`.
- `computer_scroll`: pass an element ref, not raw coordinates.
- `computer_get`: read text, value, bounds, role, or states from a ref.
- `computer_screenshot`: use for visual confirmation or when the accessibility tree is not enough.

## Reliability rules

- Use a snapshot -> act -> snapshot loop.
- Prefer refs over coordinates.
- Refs go stale after the next snapshot; do not reuse them blindly.
- Keep actions reversible and low risk unless the user explicitly asked for something destructive.
- If the accessibility tree is poor or ambiguous, use `computer_screenshot` for confirmation and explain the limitation.

## Blockers

Stop and report clearly if:

- Accessibility permission is missing.
- `agent-desktop` is unavailable or its native binary is missing.
- The target app/window cannot be found.
- Refs are stale or ambiguous after a UI transition.
- The requested action could be destructive and the user did not explicitly ask for it.
