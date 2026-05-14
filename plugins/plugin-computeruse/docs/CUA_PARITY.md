# Cua action parity

Audited against `trycua/cua` commit `c173173` from 2026-05-13.
Last local verification: 2026-05-14 on macOS.

This document tracks the action surface we expect `@elizaos/plugin-computeruse`
to expose. Cua has two related APIs:

- `computer` / `computer-server`: one WebSocket command interface for desktop
  automation, files, windows, clipboard, desktop metadata, accessibility, and
  shell execution.
- `cua-sandbox`: grouped interfaces (`shell`, `mouse`, `keyboard`, `screen`,
  `clipboard`, `tunnel`, `terminal`, `window`, `mobile`) used across Linux,
  macOS, Windows, and Android sandboxes.

## Desktop computer interface

| Cua method / command | plugin-computeruse surface | Status |
| --- | --- | --- |
| `screenshot` | `COMPUTER_USE` `action=screenshot` | Supported, per-display aware. |
| `get_screen_size` / `screen.size` | `computerState` provider, `getDisplays()` | Supported as state; not a direct `COMPUTER_USE` verb. |
| `get_cursor_position` | `ComputerInterface.getCursorPosition()` | Supported inside WS7 actor loop; host-driver live cursor read remains follow-up. |
| `left_click`, `mouse.click` | `COMPUTER_USE` `action=click` | Supported. |
| `right_click`, `mouse.right_click` | `COMPUTER_USE` `action=right_click` | Supported. |
| `double_click`, `mouse.double_click` | `COMPUTER_USE` `action=double_click` | Supported. |
| `move_cursor`, `mouse.move` | `COMPUTER_USE` `action=mouse_move` | Supported. |
| `drag_to`, `drag`, `mouse.drag` | `COMPUTER_USE` `action=drag`/`drag_to`; WS7 `drag`/`dragTo` | Supported for start/end drag. Multi-point path is normalized to start/end in WS7. |
| `mouse_down`, `mouse_up` | `COMPUTER_USE` `action=mouse_down/mouse_up`; WS7 `ComputerInterface.mouseDown/mouseUp` | Supported. |
| `middle_click` | `COMPUTER_USE` `action=middle_click` | Supported. |
| `scroll`, `mouse.scroll` | `COMPUTER_USE` `action=scroll`; WS7 `scroll` | Supported. |
| `scroll_up`, `scroll_down` | `COMPUTER_USE` `action=scroll` with direction | Supported by normalization. |
| `type_text`, `keyboard.type` | `COMPUTER_USE` `action=type` | Supported. |
| `press_key`, `keyboard.keypress` | `COMPUTER_USE` `action=key` | Supported. |
| `hotkey`, `keyboard.keypress([...])` | `COMPUTER_USE` `action=key_combo`; WS7 `hotkey` | Supported. |
| `key_down`, `key_up` | `COMPUTER_USE` `action=key_down/key_up`; WS7 `ComputerInterface.keyDown/keyUp` | Supported. |
| `get_accessibility_tree` | `COMPUTER_USE` `action=accessibility_tree`; `scene` provider | Supported via scene builder. |
| `find_element` | `COMPUTER_USE` `action=detect_elements` | Supported as scene element extraction from AX + OCR. Exact role/title/value filtering is a follow-up. |
| `to_screen_coordinates` | WS7 `ComputerInterface.toScreenCoordinates()` | Supported. |
| `to_screenshot_coordinates` | WS7 `ComputerInterface.toScreenshotCoordinates()` | Supported. |

## Vision and recognition

| Capability | plugin-computeruse surface | Status |
| --- | --- | --- |
| OCR | `COMPUTER_USE` `action=ocr`; `SceneBuilder.ocr` | Supported. At startup, computeruse registers a lazy OCR provider backed by `plugin-vision` when the `VISION` service is loaded. |
| Accessibility + OCR element detection | `COMPUTER_USE` `action=detect_elements`; `scene` provider | Supported. Returns AX nodes and OCR text boxes with display-local bounding boxes. |
| Local inference / image recognition | `plugin-vision` `VisionService.analyzeImageContent()` | Integrated as a public service seam; CUA action routing to non-OCR object recognition remains follow-up. |
| Cloud inference / VLM scene description | `plugin-vision` `describeSceneWithVLM` internally; `Scene.vlm_*` reserved fields | Partial. The scene contract has fields; direct CUA-style action routing is follow-up. |

## Files, shell, terminal, clipboard, windows

| Cua grouped interface | Cua actions | plugin-computeruse surface | Status |
| --- | --- | --- | --- |
| `shell` | `run` | `execute_command`, `terminal_execute` | Supported through guarded local command execution. |
| `terminal` | `create`, `send_input`, `resize`, `close` | `terminal_connect`, `terminal_type`, `terminal_clear`, `terminal_close` | Partial. There is a session abstraction, but no real PTY resize yet. |
| `files` / computer file commands | `file_exists`, `directory_exists`, `list_dir`, `read_text`, `write_text`, `read_bytes`, `write_bytes`, `delete_file`, `create_dir`, `delete_dir`, `get_file_size` | `file_*`, `directory_list`, `directory_delete` | Partial. Text read/write/edit/append/delete/list/exists are supported. Binary chunked read/write and create-dir alias should be added for exact Cua parity. |
| `clipboard` | `get`/`copy_to_clipboard`, `set`/`set_clipboard` | none | Gap. Add cross-platform clipboard commands. |
| `window` | `get_active_title` | `WINDOW list/focus/switch/...` | Partial. Window listing and management exists; active-title direct alias should be added. |
| computer window commands | `open`, `launch`, `get_current_window_id`, `get_application_windows`, `get_window_name`, `get_window_size`, `get_window_position`, `set_window_size`, `set_window_position`, `maximize_window`, `minimize_window`, `activate_window`, `close_window` | `WINDOW list/focus/switch/arrange/move/minimize/maximize/restore/close` | Partial. Existing local implementation covers common management; exact ID/size/position getters and open/launch aliases are follow-up. |
| desktop metadata | `get_desktop_environment`, `set_wallpaper` | none | Gap. |
| tunnel | `forward` | none | Out of scope for local host plugin unless sandbox manager is active. |

## Mobile / Android

| Cua mobile action | plugin-computeruse mobile surface | Status |
| --- | --- | --- |
| `tap`, `double_tap`, `swipe`, `scroll_up/down/left/right`, `home`, `back`, `recents`, `notifications` | Android Capacitor bridge + `MobileComputerInterface` | Supported or mapped through gestures/global actions. |
| `long_press` | Android bridge can dispatch swipe/tap only | Gap for consumer build. |
| `fling`, `gesture`, `pinch_in`, `pinch_out` | AOSP trajectory helpers exist; consumer bridge lacks these verbs | Partial. |
| `type_text`, `enter`, `backspace`, `power`, `volume_up/down`, arbitrary `key` | AOSP privileged path / Android bridge docs | Partial. Consumer build intentionally rejects unsupported keys; AOSP system-app path is documented separately. |
| Android screen and accessibility | `mobile-screen-capture`, Android AX bridge | Supported when permissions are granted. |

## Platform parity target

- macOS: primary test platform. Requires Screen Recording and Accessibility
  permissions; nut-js is the default driver with shell-driver fallback.
- Linux: target parity via nut-js, `xdotool`, `wmctrl`, and screenshot tools.
- Windows: target parity via nut-js and PowerShell fallbacks.
- Android: parity splits into consumer-app and AOSP-privileged modes.
- iOS: intentionally constrained by platform policy; no stock cross-app input.

## Immediate follow-ups

1. Add clipboard commands with macOS/Linux/Windows backends.
2. Add Cua file aliases for `directory_exists`, `create_dir`, `read_bytes`,
   `write_bytes`, and `get_file_size`.
3. Add window getters/open/launch aliases matching Cua names.
4. Add direct `find_element` filters over scene AX/OCR fields.
5. Add PTY-backed terminal sessions with resize.
