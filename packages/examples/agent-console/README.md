# Agent Console Example

Live observability dashboard for an elizaOS `AgentRuntime`. It streams model
calls, prompts, action events, evaluator events, token usage, and trajectory
state over server-sent events while you chat with the agent.

## Run

```bash
cd packages/examples/agent-console

# Set one provider key. Cerebras, Groq, OpenRouter, and OpenAI are checked in
# that order.
export OPENAI_API_KEY="..."

bun run start
```

Then open the URL printed by the server.

## Provider Environment

| Provider | Required variable | Optional model override |
| --- | --- | --- |
| Cerebras | `CEREBRAS_API_KEY` | `AGENT_MODEL` |
| Groq | `GROQ_API_KEY` | `AGENT_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` | `AGENT_MODEL` |
| OpenAI | `OPENAI_API_KEY` | `AGENT_MODEL` |

The example disables OpenAI embeddings because several OpenAI-compatible
providers used here do not expose an embeddings endpoint.

## Validate

```bash
bun run typecheck
```

The example has no external service test because it requires a live model
provider key and an interactive browser session.
