# Feed DAG Inspector

Standalone, zero-dependency visualization of ALL data flowing through the Feed game engine tick execution.

## Quick Start

```bash
# Open directly in browser — no server needed
open feed/tools/dag-visualizer/index.html

# Or serve it
npx serve feed/tools/dag-visualizer
```

## What It Shows

Click any node in the DAG to see **everything**:

- **Overview**: Node metadata, execution timing, status, data flow edges, LLM call summaries
- **Inputs**: Complete input data to the node (all fields, full objects, expandable)
- **Outputs**: Complete output data from the node (all fields, full objects, expandable)
- **LLM Calls**: Every LLM call with full system prompt, user prompt, raw response, parsed response, token counts, latency, model/provider info
- **NPCs**: Every NPC decision (action, amount, confidence, reasoning), trade (success/fail/error), post, group message
- **Raw JSON**: The complete node trace as raw JSON

## Data Loading

Three ways to load data:

1. **Demo**: Click "Load Demo" for a realistic sample trace with 24 nodes, 13 LLM calls, 8 NPCs
2. **File**: Load a `tick-summary.json` or full `TickTrace` JSON file
3. **Drag & Drop**: Drop a JSON file onto the welcome screen

## Embedding

Embed in any admin page via iframe:

```html
<iframe src="/tools/dag-visualizer/index.html" style="width:100%;height:100vh;border:none"></iframe>
```

## Generating Trace Data

Enable tracing in the Feed engine:

```bash
FEED_DAG_TRACE=true bun run game-tick
```

Traces are written to `runs/dag-traces/` with this structure:

```
runs/dag-traces/tick-{timestamp}-{number}/
  tick-summary.json          # Load this file into the visualizer
  nodes/01-init.json         # Full node data
  llm-calls/call-001-*.json  # Full LLM prompts/responses
  npc-trajectories/*.json    # Per-NPC decision logs
```
