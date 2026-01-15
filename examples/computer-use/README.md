# Computer Use Examples

End-to-end examples showing an elizaOS agent with **ComputerUse** abilities.

## Modes

- **Local mode (Windows)**: the agent controls the same machine it is running on.
- **MCP mode (any OS)**: the agent controls a **remote** machine running `computeruse-mcp-agent`.

## Examples

- `typescript/`: Small web app (chat + autonomy toggle + autonomy logs) exposing an agent with ComputerUse actions.
- `python/`: Minimal script demonstrating the Python plugin wrapper.
- `rust/`: Minimal CLI demonstrating the Rust plugin wrapper.

## Run (TypeScript interactive app)

From the repo root:

```bash
cd examples/computer-use/typescript
bun install

# Optional: enable OpenAI for real action selection
export OPENAI_API_KEY="..."

# Optional: tweak autonomy behavior
export AUTONOMY_MODE=task

bun run start
```

Then open `http://localhost:3333`.

Notes:

- Without `OPENAI_API_KEY`, the example falls back to the classic ELIZA plugin (chat will be limited, and autonomy won’t do meaningful work).
- For best cross-platform results, run ComputerUse in **MCP mode** controlling a machine that supports the target automation (often Windows).

