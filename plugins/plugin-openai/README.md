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

For text generation, set `OPENAI_BASE_URL` to the gateway's Chat Completions
base URL and `OPENAI_API_KEY` to its key. Leave `ELIZA_PROVIDER` unset for
a generic gateway, and set both small and large model IDs to models it serves:

```env
OPENAI_API_KEY=your-gateway-key
OPENAI_BASE_URL=https://gateway.example.com/v1
OPENAI_SMALL_MODEL=your-small-model
OPENAI_LARGE_MODEL=your-large-model
```

Without other model overrides, nano and medium use the small model, and mega
uses the large model. Embeddings use the same base URL and key by default.
If the gateway has no embeddings endpoint, set `OPENAI_EMBEDDING_URL`,
`OPENAI_EMBEDDING_API_KEY`, and `OPENAI_EMBEDDING_MODEL` for an embedding provider.

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
