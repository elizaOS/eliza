# @elizaos/plugin-benchmarks

elizaOS plugin that provides canonical action wrappers for five standard agent evaluation benchmarks: **vending-bench**, **WebShop**, **OSWorld**, **tau-bench**, and **VisualWebBench**.

## What it does

Benchmark harnesses evaluate agents by exposing a tool vocabulary the agent must call correctly. This plugin gives an Eliza agent a stable, typed elizaOS action for each benchmark vocabulary so that:

- Fine-tuning on benchmark traces yields consistent action names across all benchmarks.
- Benchmark harnesses can inspect the structured `data` field of the action result to score the agent's response.
- The action shape is uniform regardless of which benchmark is running.

Action handlers are intentionally thin — they capture and echo the parameters back as structured `data`. The benchmark environment (not the plugin) performs the actual operation and scoring.

## Capabilities / actions registered

| Action | Description |
|---|---|
| `VENDING_MACHINE` | Vending-bench operations: `view_state`, `view_suppliers`, `place_order`, `restock_slot`, `set_price`, `collect_cash`, `update_notes`, `check_deliveries`, `advance_day`. Also promoted as `VENDING_MACHINE_<SUBACTION>` virtuals. |
| `WEBSHOP` | WebShop benchmark operations: `search`, `click`, `select_option`, `back`, `buy`. Also promoted as `WEBSHOP_<SUBACTION>` virtuals. |
| `OSWORLD` | OSWorld desktop-control operations via pyautogui semantics: `click`, `double_click`, `right_click`, `type`, `key`, `scroll`, `drag`, `screenshot`, `wait`, `done`, `fail`. Also promoted as `OSWORLD_<SUBACTION>` virtuals. |
| `TAU_BENCH_TOOL` | tau-bench pass-through tool router. `tool_name` selects the dynamic tool (retail / airline domains); `arguments` carries the JSON payload. Not promoted into per-tool virtuals because `tool_name` is free-text. |
| `VISUALWEBBENCH_TASK` | VisualWebBench sub-tasks: `web_caption`, `webqa`, `heading_ocr`, `element_ocr`, `element_ground`, `action_prediction`, `action_ground`. Also promoted as `VISUALWEBBENCH_TASK_<SUBACTION>` virtuals. |

37 actions total are registered in the plugin.

## How to enable

Add the plugin to an agent's character config or runtime:

```typescript
import benchmarksPlugin from "@elizaos/plugin-benchmarks";

// In your AgentRuntime plugins array:
plugins: [benchmarksPlugin]
```

Or via a character JSON file:

```json
{
  "plugins": ["@elizaos/plugin-benchmarks"]
}
```

## Required configuration

None. The plugin has no required environment variables. It reads no configuration at runtime.

## Development

```bash
# From repo root
bun run --cwd plugins/plugin-benchmarks build
bun run --cwd plugins/plugin-benchmarks test
bun run --cwd plugins/plugin-benchmarks typecheck
```
