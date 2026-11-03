# Valhalla Brain

Valhalla Brain is the advisory model layer. It uses the same kind of model providers as ElizaOS. It does not place trades and it does not move funds.

## Providers

Pick one in Controls, under Brain. Gemini is the default and uses a Google AI Studio key. The others are OpenAI, Anthropic, xAI Grok, OpenRouter, and local Ollama.

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
