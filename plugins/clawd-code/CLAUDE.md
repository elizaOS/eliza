# Clawd Code — Compatibility Agent Instructions

This file is kept only for agent runtimes that still auto-load `CLAUDE.md`.
The canonical Clawd harness is [`CLAWD.md`](./CLAWD.md).

When this file is loaded, treat the project as Clawd Code:

- Use `clawd-code` for code, trade, research, image, and voice workflows.
- Use `clawd --plugin-dir ./clawd-plugin` for the bundled Clawd Code plugin.
- Read skill instructions from `clawd-plugin/skills/` before implementing domain-specific Solana, DFlow, Phantom, Jupiter, or SVM work.
- Default all trading paths to PAPER mode unless `LIVE_TRADING=true`, `OPERATOR_CONFIRMED=true`, and `PERPS_SIM_ONLY=false`.
- Never hardcode or mock live chain state when MCP tools are available.
