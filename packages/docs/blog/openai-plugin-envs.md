---
title: Using OpenAI Plugin Envs for Any OpenAI-Compatible Provider
authors: team
date: 2025-04-24
description: Learn how to configure the OpenAI plugin to work with any OpenAI-compatible provider using environment variables.
---

# 🚀 Using OpenAI Plugin Envs Any OpenAI-Compatible Provider

The `plugin-openai` package in this project can connect to any OpenAI-compatible API provider—not just OpenAI itself! Thanks to flexible environment variable support, you can swap between providers like Azure, OpenRouter, or even your own local LLM with just a few tweaks. It’s that easy!

## 🤔 What is an OpenAI-Compatible Provider?

An OpenAI-compatible provider is any service that implements the OpenAI API spec. Popular examples include:

- [OpenRouter](https://openrouter.ai/)
- [Ollama](https://ollama.com/) (with its OpenAI-compatible API)
- [Local LLMs with an OpenAI API wrapper](https://github.com/abetlen/llama-cpp-python)
- Other cloud or self-hosted endpoints

> **Note:** If your provider supports the OpenAI API, this plugin can probably talk to it!

## 🛠️ Key Environment Variables

The following environment variables are supported by the OpenAI plugin:

| Variable                      | Purpose                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `OPENAI_API_KEY`              | The API key for authentication (required)                  |
| `OPENAI_BASE_URL`             | The base URL for the API (override to use other providers) |
| `OPENAI_SMALL_MODEL`          | Default small model name                                   |
| `OPENAI_LARGE_MODEL`          | Default large model name                                   |
| `OPENAI_EMBEDDING_MODEL`      | Embedding model name                                       |
| `OPENAI_EMBEDDING_DIMENSIONS` | Embedding vector dimensions                                |
| `SMALL_MODEL`                 | (Fallback) Small model name                                |
| `LARGE_MODEL`                 | (Fallback) Large model name                                |

## Example: Connecting to OpenRouter

```env
OPENAI_API_KEY=your-openrouter-key
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_SMALL_MODEL=openrouter/gpt-3.5-turbo
OPENAI_LARGE_MODEL=openrouter/gpt-4
```

## Example: Connecting to Ollama

```env
OPENAI_API_KEY=ollama-local-demo
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_SMALL_MODEL=llama2
OPENAI_LARGE_MODEL=llama2:70b
```

## Example: Connecting to a Local LLM (Llama.cpp)

```env
OPENAI_API_KEY=sk-local-demo
OPENAI_BASE_URL=http://localhost:8000/v1
OPENAI_SMALL_MODEL=llama-2-7b-chat
OPENAI_LARGE_MODEL=llama-2-13b-chat
```

## Example: Connecting to LM Studio

[LM Studio](https://lmstudio.ai/) is a popular desktop app for running large language models locally. It provides an OpenAI-compatible API server, so you can use it as a drop-in replacement for OpenAI or other providers.

To use LM Studio with the OpenAI plugin, start the LM Studio API server (default port 1234) and set your environment variables as follows:

```env
OPENAI_API_KEY=lmstudio-local-demo # (can be any non-empty string)
OPENAI_BASE_URL=http://localhost:1234/v1
OPENAI_SMALL_MODEL=your-model-name-here
OPENAI_LARGE_MODEL=your-model-name-here
```

- Make sure to use the model identifier as listed in LM Studio for the `OPENAI_SMALL_MODEL` and `OPENAI_LARGE_MODEL` values.
- LM Studio supports the `/v1/models`, `/v1/chat/completions`, `/v1/embeddings`, and `/v1/completions` endpoints.
- You can reuse any OpenAI-compatible SDK by pointing the base URL to `http://localhost:1234/v1`.

For more details, see the [LM Studio OpenAI Compatibility API docs](https://lmstudio.ai/docs/app/api/endpoints/openai).

> **Reminder:**
> An embedding model is still required for full plugin functionality. We recommend pairing your setup with the Local AI plugin, an OpenAI API key, or a provider that also supports embeddings (such as OpenAI, OpenRouter, or LocalAI).

:::tip
**Best Practice:**
Keep your `.env` file out of version control! Use environment variable management tools or deployment secrets for production.
:::

> **Reminder:**
>
> - If `OPENAI_BASE_URL` is not set, the plugin defaults to the official OpenAI endpoint.
> - Model names must match those supported by your provider.
> - Some providers may require extra headers or parameters—check their docs!

## 🐞 Troubleshooting

- If you see errors about missing `OPENAI_API_KEY`, make sure it’s set in your environment.
- For provider-specific errors, double-check your `OPENAI_BASE_URL` and model names.

## 🎯 Conclusion

By customizing your environment variables, you can use the OpenAI plugin with any provider that supports the OpenAI API. Swap providers, use local models, or experiment with new services—all with a few config changes. Happy hacking!

---

## 🔗 More Links

- [Plugin Guide](https://eliza.how/docs/plugins)
- [OpenAI API Reference](https://platform.openai.com/docs/api-reference)
- [OpenRouter Docs](https://openrouter.ai/docs)
- [Ollama Docs](https://github.com/ollama/ollama/blob/main/docs/openai.md)
- [LM Studio Docs](https://lmstudio.ai/docs/app/api/endpoints/openai)

_If you have questions or want to contribute more provider examples, feel free to open a PR!_
