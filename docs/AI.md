# Valhalla Brain

Valhalla Brain is the advisory model layer. It uses the same kind of model providers as ElizaOS. It does not place trades and it does not move funds.

## Providers

Pick one in Controls, under Brain. Gemini is the default and uses a Google AI Studio key. The others are OpenAI, Anthropic, xAI Grok, OpenRouter, Together AI, and local Ollama.

Together AI serves DeepSeek. The default model is `deepseek-ai/DeepSeek-V4.1-Flash`. It costs $0.30 per 1M input tokens and $1.20 per 1M output tokens. You can set a different DeepSeek model for each feature. Use the exact model string from the Together AI serverless model list.

## Keys in .env

You can put a provider key in `.env` instead of typing it into Controls. The desk reads these names on start:

| Name | Provider |
| --- | --- |
| `TOGETHER_API_KEY` | Together AI |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `XAI_API_KEY` or `GROK_API_KEY` | xAI Grok |
| `OPENROUTER_API_KEY` | OpenRouter |
| `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` | Gemini |

Together AI is checked first, so a desk that sets several keys uses DeepSeek. A key you save later in Controls wins over `.env`, because that is your explicit choice.

The `.env` file stays on this PC. Do not commit it.

Ollama stays on this PC at `127.0.0.1`. The other keys are encrypted on this PC with the same lock as the bot wallet. The phone never receives a key. Keys are not written to the log.

Each feature can use its own model name: chat, analyst, report, repair, and tuner. Output is capped. A monthly dollar cap stops new model calls when it is spent. Status lines still work.

## What it can do

Chat on the desk and on the phone can ask about positions, P&L, why a coin was skipped, and market questions. Answers stay inside the safety rules.

The token analyst explains safety, liquidity, holder spread, and untrusted X text. It adds a confidence number. It can only make a pass fail. It cannot approve a coin the rule engine already blocked.

Daily and session reports are plain-English summaries. They can suggest a tighter limit. They cannot promise profit.

Self-repair diagnosis is the Layer 2 report already in the agent. A code change is still never applied.

The strategy tuner suggests a smaller size or a tighter stop from the trade history. You must tap confirm. The change is logged. Rollback restores the previous settings.

## Hard rules

The model cannot trade outside the rule engine, see keys, loosen a stop, or turn a safety check off. Text from X and from token metadata is labeled untrusted and is not treated as an instruction.
