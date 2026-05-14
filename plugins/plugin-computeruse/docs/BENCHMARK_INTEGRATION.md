# Benchmark Integration

`plugin-computeruse` has two benchmark-facing surfaces:

- `OSWorldAdapter`: a local host-desktop adapter for OSWorld-style observation
  and action loops.
- `fromCuaBenchAction`: a pure adapter for CuaBench action dataclasses,
  dictionaries, repr strings, and snake-case strings.
- `CuaBenchSession`: a thin service wrapper with CuaBench-shaped helpers for
  screenshots, actions, shell commands, files, and app launch.

## Current Status

| Benchmark surface | Status | Notes |
| --- | --- | --- |
| OSWorld `computer_13` | Supported | Exports `OSWorldAdapter`, `fromOSWorldAction`, and `toOSWorldAction`. Raw `MOUSE_DOWN`, `MOUSE_UP`, `KEY_DOWN`, and `KEY_UP` now map to public desktop actions. |
| OSWorld `pyautogui` | Partial | Covers common click/type/key/hotkey/move/scroll/drag strings. It is intentionally not a Python interpreter. |
| CuaBench action objects | Supported as pure conversion | `ClickAction`, `RightClickAction`, `DoubleClickAction`, `MiddleClickAction`, `DragAction`, `MoveToAction`, `ScrollAction`, `TypeAction`, `KeyAction`, `HotkeyAction`, `WaitAction`, and `DoneAction` map to plugin actions or control records. |
| CuaBench session wrapper | Supported | `CuaBenchSession` wraps `ComputerUseService` for screenshot, action, command, file, and launch helpers. |
| CuaBench task runner | Not integrated yet | Upstream task setup/evaluate hooks and Docker/QEMU runners are Python-side lifecycle concepts. This plugin now has the action/session building block, not a full CuaBench runner. |

## CuaBench Action Coverage

| CuaBench action | Plugin output |
| --- | --- |
| `ClickAction` | `COMPUTER_USE action=click` |
| `RightClickAction` | `COMPUTER_USE action=right_click` |
| `DoubleClickAction` | `COMPUTER_USE action=double_click` |
| `MiddleClickAction` | `COMPUTER_USE action=middle_click` |
| `DragAction(from_x, from_y, to_x, to_y)` | `COMPUTER_USE action=drag` |
| `MoveToAction` | `COMPUTER_USE action=mouse_move` |
| `ScrollAction` | `COMPUTER_USE action=scroll` |
| `TypeAction` | `COMPUTER_USE action=type` |
| `KeyAction` | `COMPUTER_USE action=key` |
| `HotkeyAction` | `COMPUTER_USE action=key_combo` |
| `WaitAction` | `{ kind: "control", control: { kind: "wait" } }` |
| `DoneAction` | `{ kind: "control", control: { kind: "done" } }` |

## Tests

```bash
bun run --cwd plugins/plugin-computeruse test -- src/__tests__/benchmark/cuabench-action-converter.test.ts
bun run --cwd plugins/plugin-computeruse test -- src/__tests__/benchmark/cuabench-session.test.ts
```

Live host-desktop benchmark smoke tests remain gated by the existing real-test
conventions because they move the mouse, read windows, and may require macOS
Screen Recording and Accessibility permissions.
