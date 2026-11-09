# @elizaos/plugin-openai

OpenAI model-provider plugin for elizaOS: text generation, embeddings, image
generation/description, audio transcription, text-to-speech, and deep research via the
OpenAI Responses API.

Register the plugin and configure `OPENAI_API_KEY`, or the credentials and base URL for
the chosen compatible provider. Dispatch through runtime.useModel. Keep provider
credentials server-side. Strict wire-schema adaptation preserves the original schema for
application-side validation; usage records identify the actual serving provider/model.

Text calls pass non-empty stop sequences, frequency/presence penalties, and seeds
to the SDK. Zero values are preserved. Empty stop lists are omitted. Omitted
settings use provider defaults; the provider and model determine support. Stop
text uses the existing Unicode cleanup.

## Using an OpenAI-compatible gateway

Set `OPENAI_BASE_URL` to the gateway's OpenAI-compatible endpoint, put the
gateway key in `OPENAI_API_KEY`, and name a model for each size the gateway
serves. Sizes left unset fall back: nano and medium to small, mega to large.

```env
OPENAI_API_KEY=your-gateway-key
OPENAI_BASE_URL=https://api.teamorouter.com/v1   # e.g. TeamoRouter
OPENAI_SMALL_MODEL=glm-5.3-flash
OPENAI_LARGE_MODEL=claude-sonnet-5-5
```

Embeddings use `OPENAI_BASE_URL` too unless `OPENAI_EMBEDDING_URL` is set. If
the gateway has no embeddings endpoint, point `OPENAI_EMBEDDING_URL` and
`OPENAI_EMBEDDING_API_KEY` at a provider that does.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-openai build  # build
bun run --cwd plugins/plugin-openai test   # tests
```

The root also exports stateless direct media adapters for explicit own-key host
configuration. `./direct-media` provides the same adapters without initializing
model registration. Callers supply credentials and cancellation.
`./config` exports the settings readers, such as `isCerebrasMode` and
`resolveOpenAIBaseURL`, without the model handlers or the tokenizer encodings.
