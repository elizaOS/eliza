# @elizaos/plugin-computeruse

Desktop and mobile computer-use plugin for elizaOS agents.

The canonical local desktop action is `COMPUTER_USE`. It supports:

- `screenshot`
- `click`, `click_with_modifiers`, `double_click`, `right_click`, `middle_click`
- `mouse_move`, `mouse_down`, `mouse_up`, `drag`, `drag_to`, `left_click_drag`, `scroll`
- `type`, `key`, `key_down`, `key_up`, `key_combo`
- `ocr`, `detect_elements`, `find_element`, `accessibility_tree`

The plugin also registers:

- `WINDOW` for desktop window list/focus/switch/arrange/move/minimize/maximize/restore/close.
- `COMPUTER_USE_AGENT` for the scene/brain/actor/dispatch loop.
- `computerState` and `scene` providers for live display, app, accessibility,
  OCR, and visual-scene state.

## Vision integration

`plugin-computeruse` owns the scene builder and OCR provider registry. At
service startup it registers a lazy provider named `plugin-vision-ocr`; when
`plugin-vision` is loaded, OCR calls route through `VisionService`.

This keeps `plugin-computeruse` usable without installing vision model
dependencies, while still allowing:

- local OCR through `plugin-vision` backends,
- Apple Vision OCR through the mobile/iOS bridge provider,
- scene element detection from accessibility nodes plus OCR boxes,
- future local/cloud image recognition through `VisionService.analyzeImageContent()`.

## Cua parity

The current parity audit against `trycua/cua` is documented in
[`docs/CUA_PARITY.md`](docs/CUA_PARITY.md). That file lists every Cua action
surface found in the upstream computer and sandbox APIs, the matching
`plugin-computeruse` action/provider/interface, and known gaps.

Benchmark-facing adapters are documented in
[`docs/BENCHMARK_INTEGRATION.md`](docs/BENCHMARK_INTEGRATION.md).

## Platform notes

- macOS: tested locally; requires Screen Recording and Accessibility
  permissions for full desktop control.
- Linux: target support uses nut-js first, then shell tools such as `xdotool`
  and `wmctrl`.
- Windows: target support uses nut-js first, then PowerShell fallbacks.
- Android: consumer-app support runs through AccessibilityService,
  MediaProjection, and global actions; AOSP-privileged input has a separate
  path documented in `docs/AOSP_SYSTEM_APP.md`.
- iOS: stock iOS does not allow cross-app input. Supported surfaces are
  ReplayKit capture, Apple Vision OCR, App Intents, and own-app
  accessibility.
