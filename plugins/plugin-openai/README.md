# @elizaos/plugin-openai

OpenAI model-provider plugin for elizaOS: text generation, embeddings, image
generation/description, audio transcription, text-to-speech, and deep research via the
OpenAI Responses API.

Register the plugin and configure `OPENAI_API_KEY`, or the credentials and base URL for
the chosen compatible provider. Dispatch through runtime.useModel. Keep provider
credentials server-side. Strict wire-schema adaptation preserves the original schema for
application-side validation; usage records identify the actual serving provider/model.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-openai build  # build
bun run --cwd plugins/plugin-openai test   # tests
```
