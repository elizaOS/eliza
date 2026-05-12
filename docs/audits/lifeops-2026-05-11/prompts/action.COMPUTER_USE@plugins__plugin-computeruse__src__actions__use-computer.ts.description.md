# `action.COMPUTER_USE@plugins/plugin-computeruse/src/actions/use-computer.ts.description`

- **Kind**: action-description
- **Owner**: plugins/plugin-computeruse
- **File**: `plugins/plugin-computeruse/src/actions/use-computer.ts:199`
- **Token count**: 144
- **Last optimized**: never
- **Action**: COMPUTER_USE
- **Similes**: USE_COMPUTER, CONTROL_COMPUTER, COMPUTER_ACTION, DESKTOP_ACTION, CLICK, CLICK_SCREEN, TYPE_TEXT, PRESS_KEY, KEY_COMBO, SCROLL_SCREEN, MOVE_MOUSE, DRAG, MOUSE_CLICK, CLICK_WITH_MODIFIERS, TAKE_SCREENSHOT, CAPTURE_SCREEN, SEE_SCREEN

## Current text
```
computer_use:\n  purpose: Canonical cross-platform computer-use action for real desktop interaction on macOS, Linux, and Windows when direct computer operation is required.\n  guidance: Take a screenshot before acting. After each desktop action, the result includes a screenshot when available. Use this standard plugin action, not a LifeOps wrapper, for Finder/Desktop/native-app/browser/file/terminal workflows on the owner's machine.\n  actions: screenshot/click/click_with_modifiers/double_click/right_click/mouse_move/type/key/key_combo/scroll/drag/detect_elements/ocr.
```

## Compressed variant
```
Canonical cross-platform desktop control: screenshot/click/modified click/double/right/move/type/key/key_combo/scroll/drag/detect_elements/ocr.
```

## Usage stats (latest trajectories)
- Invocations: 0 (this prompt was not matched in any recent trajectory)

## Sample failure transcripts
None.

## Suggested edits (heuristic)
- Compressed variant exists (143 chars vs 574 chars — 75% shorter). Consider promoting it when planner cache pressure is high.

## Actions
- Accept a candidate rewrite: `bun run lifeops:prompt-accept -- --id <id> --from <candidate-file>`
- Freeze (skip future optimization): `bun run lifeops:prompt-freeze -- --id <id>`
