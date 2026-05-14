# Table of Supported Models

Below is a comprehensive table of models supported for running leaderboard evaluations. Each model entry indicates whether it supports native Function Calling (FC) or requires a special prompt format to generate function calls. Models marked with `💻` are intended to be hosted locally (using vllm or sglang), while models without the `💻` icon are accessed via API calls. To quickly see all available models, you can also run the `bfcl models` command.

## Function Calling (FC) vs. Prompt Mode

- **Function Calling (FC) Mode:**  
  Models with native tool/function calling capabilities. For example, OpenAI GPT in FC mode uses the `tools` section as documented in the [OpenAI function calling guide](https://platform.openai.com/docs/guides/function-calling).

- **Prompt Mode:**  
  Models without native function calling capabilities rely on traditional prompt-based interactions to produce function calls in the desired format, and we supply the function definitions in the `system prompt` section as opposed to a dedicated `tools` section. Prompt mode also serve as an alternative approach for models that support FC mode but do not fully leverage its function calling ability (i.e., we only use its normal text generation capability).

## Understanding Versioned Models

For model names containing `{...}`, multiple versions are available. For example, `meta-llama/Llama-3.1-{8B,70B}-Instruct` means we support both models: `meta-llama/Llama-3.1-8B-Instruct` and `meta-llama/Llama-3.1-70B-Instruct`.

| Base Model                             | Type             | Provider       | Model ID on BFCL                                            |
| -------------------------------------- | ---------------- | -------------- | ----------------------------------------------------------- |
| Amazon-Nova-2-Lite-v1:0                | Function Calling | Amazon         | nova-2-lite-v1.0                                            |
| Amazon-Nova-Micro-v1:0                 | Function Calling | Amazon         | nova-micro-v1.0                                             |
| Amazon-Nova-Pro-v1:0                   | Function Calling | Amazon         | nova-pro-v1.0                                               |
| Arch-Agent-{1.5B,3B,7B,32B}            | Function Calling | Self-hosted 💻 | katanemo/Arch-Agent-{1.5B,3B,7B,32B}                        |
| Bielik-11B-v2.3-Instruct               | Prompt           | Self-hosted 💻 | speakleash/Bielik-11B-v2.3-Instruct                         |
| BitAgent-8B                            | Prompt           | Self-hosted 💻 | BitAgent/BitAgent-8B                                        |
| BitAgent-Bounty-8B                     | Function Calling | Self-hosted 💻 | BitAgent/BitAgent-Bounty-8B                                 |
| claude-3.5-haiku-20241022              | Function Calling | Anthropic      | claude-haiku-4-5-20251001-FC                                |
| claude-3.5-haiku-20241022              | Prompt           | Anthropic      | claude-haiku-4-5-20251001                                   |
| Claude-Opus-4.5-20251101               | Function Calling | Anthropic      | claude-opus-4-5-20251101-FC                                 |
| Claude-Opus-4.5-20251101               | Prompt           | Anthropic      | claude-opus-4-5-20251101                                    |
| Claude-Sonnet-4.5-20250929             | Function Calling | Anthropic      | claude-sonnet-4-5-20250929-FC                               |
| Claude-Sonnet-4.5-20250929             | Prompt           | Anthropic      | claude-sonnet-4-5-20250929                                  |
| CoALM-{8B,70B,405B}                    | Prompt           | Self-hosted 💻 | uiuc-convai/CoALM-{8B,70B,405B}                             |
| Command A                              | Function Calling | Cohere         | command-a-03-2025-FC                                        |
| Command A Reasoning                    | Function Calling | Cohere         | command-a-reasoning-08-2025-FC                              |
| Command R7B                            | Function Calling | Cohere         | command-r7b-12-2024-FC                                      |
| DeepSeek-R1                            | Prompt           | Self-hosted 💻 | deepseek-ai/DeepSeek-R1                                     |
| DeepSeek-V3.2-Exp                      | Function Calling | DeepSeek       | DeepSeek-V3.2-Exp-FC                                        |
| DeepSeek-V3.2-Exp                      | Prompt           | DeepSeek       | DeepSeek-V3.2-Exp                                           |
| DeepSeek-V3.2-Exp (Prompt + Thinking)  | Prompt           | DeepSeek       | DeepSeek-V3.2-Exp-thinking                                  |
| DM-Cito-32B-v1                         | Prompt           | Mininglamp     | DM-Cito-32B-v1                                              |
| DM-Cito-8B-v3                          | Prompt           | Mininglamp     | DM-Cito-8B-v3                                               |
| Falcon3-{1B,3B,7B,10B}-Instruct        | Function Calling | Self-hosted 💻 | tiiuae/Falcon3-{1B,3B,7B,10B}-Instruct-FC                   |
| FireFunction-v2                        | Function Calling | Fireworks      | firefunction-v2-FC                                          |
| Functionary-Medium-v3.1                | Function Calling | MeetKai        | meetkai/functionary-medium-v3.1-FC                          |
| Functionary-Small-v3.1                 | Function Calling | MeetKai        | meetkai/functionary-small-v3.1-FC                           |
| Gemini-2.5-Flash                       | Function Calling | Google         | gemini-2.5-flash-FC                                         |
| Gemini-2.5-Flash                       | Prompt           | Google         | gemini-2.5-flash                                            |
| Gemini-2.5-Flash-Lite                  | Function Calling | Google         | gemini-2.5-flash-lite-FC                                    |
| Gemini-2.5-Flash-Lite                  | Prompt           | Google         | gemini-2.5-flash-lite                                       |
| Gemini-3-Pro-Preview                   | Function Calling | Google         | gemini-3-pro-preview-FC                                     |
| Gemini-3-Pro-Preview                   | Prompt           | Google         | gemini-3-pro-preview                                        |
| Gemini-3.1-Flash-Lite-Preview          | Function Calling | Google         | gemini-3.1-flash-lite-preview-FC                            |
| Gemini-3.1-Flash-Lite-Preview          | Prompt           | Google         | gemini-3.1-flash-lite-preview                               |
| Gemma-3-{1b,4b,12b,27b}-it             | Prompt           | Self-hosted 💻 | google/gemma-3-{1b,4b,12b,27b}-it                           |
| FunctionGemma-270m-it                  | Function Calling | Self-hosted 💻 | google/functiongemma-270m-it-FC                             |
| GLM-4-9b-Chat                          | Function Calling | Self-hosted 💻 | THUDM/glm-4-9b-chat                                         |
| GLM-4.5                                | Function Calling | Zhipu AI       | glm-4.5-FC                                                  |
| GLM-4.5-Air                            | Function Calling | Zhipu AI       | glm-4.5-air-FC                                              |
| GLM-4.6                                | Function Calling | Zhipu AI       | glm-4.6-FC                                                  |
| GoGoAgent                              | Prompt           | BitAgent       | BitAgent/GoGoAgent                                          |
| Gorilla-OpenFunctions-v2               | Function Calling | Gorilla LLM    | gorilla-openfunctions-v2                                    |
| GPT-4.1-2025-04-14                     | Function Calling | OpenAI         | gpt-4.1-2025-04-14-FC                                       |
| GPT-4.1-2025-04-14                     | Prompt           | OpenAI         | gpt-4.1-2025-04-14                                          |
| GPT-4.1-mini-2025-04-14                | Function Calling | OpenAI         | gpt-4.1-mini-2025-04-14-FC                                  |
| GPT-4.1-mini-2025-04-14                | Prompt           | OpenAI         | gpt-4.1-mini-2025-04-14                                     |
| GPT-4.1-nano-2025-04-14                | Function Calling | OpenAI         | gpt-4.1-nano-2025-04-14-FC                                  |
| GPT-4.1-nano-2025-04-14                | Prompt           | OpenAI         | gpt-4.1-nano-2025-04-14                                     |
| GPT-4o-2024-11-20                      | Function Calling | OpenAI         | gpt-4o-2024-11-20-FC                                        |
| GPT-4o-2024-11-20                      | Prompt           | OpenAI         | gpt-4o-2024-11-20                                           |
| GPT-4o-mini-2024-07-18                 | Function Calling | OpenAI         | gpt-4o-mini-2024-07-18-FC                                   |
| GPT-4o-mini-2024-07-18                 | Prompt           | OpenAI         | gpt-4o-mini-2024-07-18                                      |
| GPT-5-mini-2025-08-07                  | Function Calling | OpenAI         | gpt-5-mini-2025-08-07-FC                                    |
| GPT-5-mini-2025-08-07                  | Prompt           | OpenAI         | gpt-5-mini-2025-08-07                                       |
| GPT-5-nano-2025-08-07                  | Function Calling | OpenAI         | gpt-5-nano-2025-08-07-FC                                    |
| GPT-5-nano-2025-08-07                  | Prompt           | OpenAI         | gpt-5-nano-2025-08-07                                       |
| GPT-5.2-2025-12-11                     | Function Calling | OpenAI         | gpt-5.2-2025-12-11-FC                                       |
| GPT-5.2-2025-12-11                     | Prompt           | OpenAI         | gpt-5.2-2025-12-11                                          |
| Granite-20b-FunctionCalling            | Function Calling | Self-hosted 💻 | ibm-granite/granite-20b-functioncalling                     |
| Granite-3.1-8B-Instruct                | Function Calling | Self-hosted 💻 | ibm-granite/granite-3.1-8b-instruct                         |
| Granite-3.2-8B-Instruct                | Function Calling | Self-hosted 💻 | ibm-granite/granite-3.2-8b-instruct                         |
| Granite-4.0-350m                       | Function Calling | Self-hosted 💻 | ibm-granite/granite-4.0-350m                                |
| Grok-4-0709                            | Function Calling | xAI            | grok-4-0709-FC                                              |
| Grok-4-0709                            | Prompt           | xAI            | grok-4-0709                                                 |
| Grok-4-1-fast-non-reasoning            | Function Calling | xAI            | grok-4-1-fast-non-reasoning-FC                              |
| Grok-4-1-fast-reasoning                | Function Calling | xAI            | grok-4-1-fast-reasoning-FC                                  |
| Haha-7B                                | Prompt           | Self-hosted 💻 | ZJared/Haha-7B                                              |
| Hammer2.1-{0.5b,1.5b,3b,7b}            | Function Calling | Self-hosted 💻 | MadeAgents/Hammer2.1-{0.5b,1.5b,3b,7b}                      |
| ling-lite-v1.5                         | Prompt           | Ling           | Ling/ling-lite-v1.5                                         |
| Llama-3.1-{8B,70B}-Instruct            | Function Calling | Self-hosted 💻 | meta-llama/Llama-3.1-{8B,70B}-Instruct-FC                   |
| Llama-3.1-{8B,70B}-Instruct            | Prompt           | Self-hosted 💻 | meta-llama/Llama-3.1-{8B,70B}-Instruct                      |
| Llama-3.1-Nemotron-Ultra-253B-v1       | Function Calling | NVIDIA         | nvidia/llama-3.1-nemotron-ultra-253b-v1                     |
| Llama-3.2-{1B,3B}-Instruct             | Function Calling | Self-hosted 💻 | meta-llama/Llama-3.2-{1B,3B}-Instruct-FC                    |
| Llama-3.3-70B-Instruct                 | Function Calling | Self-hosted 💻 | meta-llama/Llama-3.3-70B-Instruct-FC                        |
| Llama-4-Maverick-17B-128E-Instruct-FP8 | Prompt           | Novita AI      | meta-llama/llama-4-maverick-17b-128e-instruct-fp8-novita    |
| Llama-4-Maverick-17B-128E-Instruct-FP8 | Function Calling | Novita AI      | meta-llama/llama-4-maverick-17b-128e-instruct-fp8-FC-novita |
| Llama-4-Maverick-17B-128E-Instruct-FP8 | Function Calling | Self-hosted 💻 | meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8-FC        |
| Llama-4-Scout-17B-16E-Instruct         | Prompt           | Novita AI      | meta-llama/llama-4-scout-17b-16e-instruct-novita            |
| Llama-4-Scout-17B-16E-Instruct         | Function Calling | Novita AI      | meta-llama/llama-4-scout-17b-16e-instruct-FC-novita         |
| Llama-4-Scout-17B-16E-Instruct         | Function Calling | Self-hosted 💻 | meta-llama/Llama-4-Scout-17B-16E-Instruct-FC                |
| MiniCPM3-4B                            | Prompt           | Self-hosted 💻 | openbmb/MiniCPM3-4B                                         |
| MiniCPM3-4B-FC                         | Function Calling | Self-hosted 💻 | openbmb/MiniCPM3-4B-FC                                      |
| MiniCPM-SALA                           | Function Calling | Self-hosted 💻 | openbmb/MiniCPM-SALA-FC                                     |
| Ministral-8B-Instruct-2410             | Prompt           | Self-hosted 💻 | mistralai/Ministral-8B-Instruct-2410                        |
| mistral-large-2411                     | Function Calling | Mistral AI     | mistral-large-2411-FC                                       |
| mistral-large-2411                     | Prompt           | Mistral AI     | mistral-large-2411                                          |
| Mistral-Medium-2505                    | Function Calling | Mistral AI     | mistral-medium-2505-FC                                      |
| Mistral-Medium-2505                    | Prompt           | Mistral AI     | mistral-medium-2505                                         |
| Mistral-small-2506                     | Function Calling | Mistral AI     | mistral-small-2506-FC                                       |
| Mistral-Small-2506                     | Prompt           | Mistral AI     | mistral-small-2506                                          |
| Moonshotai-Kimi-K2-Instruct            | Function Calling | MoonshotAI     | kimi-k2-0905-preview-FC                                     |
| Moonshotai-Kimi-K2-Instruct            | Prompt           | MoonshotAI     | kimi-k2-0905-preview                                        |
| Nanbeige3.5-Pro-Thinking               | Function Calling | Nanbeige       | Nanbeige3.5-Pro-Thinking-FC                                 |
| Nanbeige4-3B-Thinking-2511             | Function Calling | Self-hosted 💻 | Nanbeige/Nanbeige4-3B-Thinking-2511                         |
| Nemotron-4-340b-instruct               | Prompt           | NVIDIA         | nvidia/nemotron-4-340b-instruct                             |
| o3-2025-04-16                          | Function Calling | OpenAI         | o3-2025-04-16-FC                                            |
| o3-2025-04-16                          | Prompt           | OpenAI         | o3-2025-04-16                                               |
| o4-mini-2025-04-16                     | Function Calling | OpenAI         | o4-mini-2025-04-16-FC                                       |
| o4-mini-2025-04-16                     | Prompt           | OpenAI         | o4-mini-2025-04-16                                          |
| Open-Mistral-Nemo-2407                 | Function Calling | Mistral AI     | open-mistral-nemo-2407-FC                                   |
| Open-Mistral-Nemo-2407                 | Prompt           | Mistral AI     | open-mistral-nemo-2407                                      |
| palmyra-x-004                          | Function Calling | Writer         | palmyra-x-004                                               |
| Phi-4                                  | Prompt           | Self-hosted 💻 | microsoft/phi-4                                             |
| Phi-4-mini-instruct                    | Function Calling | Self-hosted 💻 | microsoft/Phi-4-mini-instruct-FC                            |
| Phi-4-mini-instruct                    | Prompt           | Self-hosted 💻 | microsoft/Phi-4-mini-instruct                               |
| Qwen/QwQ-32B                           | Function Calling | Novita AI      | qwen/qwq-32b-FC-novita                                      |
| Qwen/QwQ-32B                           | Prompt           | Novita AI      | qwen/qwq-32b-novita                                         |
| Qwen3-{0.6B,1.7B,4B,8B,14B,32B}        | Function Calling | Qwen           | qwen3-{0.6b,1.7b,4b,8b,14b,32b}-FC                          |
| Qwen3-{0.6B,1.7B,4B,8B,14B,32B}        | Prompt           | Qwen           | qwen3-{0.6b,1.7b,4b,8b,14b,32b}                             |
| Qwen3-{0.6B,1.7B,8B,14B,32B}           | Function Calling | Self-hosted 💻 | Qwen/Qwen3-{0.6B,1.7B,8B,14B,32B}-FC                        |
| Qwen3-{0.6B,1.7B,8B,14B,32B}           | Prompt           | Self-hosted 💻 | Qwen/Qwen3-{0.6B,1.7B,8B,14B,32B}                           |
| Qwen3-235B-A22B-Instruct-2507          | Function Calling | Qwen           | qwen3-235b-a22b-instruct-2507-FC                            |
| Qwen3-235B-A22B-Instruct-2507          | Function Calling | Self-hosted 💻 | Qwen/Qwen3-235B-A22B-Instruct-2507-FC                       |
| Qwen3-235B-A22B-Instruct-2507          | Prompt           | Qwen           | qwen3-235b-a22b-instruct-2507                               |
| Qwen3-235B-A22B-Instruct-2507          | Prompt           | Self-hosted 💻 | Qwen/Qwen3-235B-A22B-Instruct-2507                          |
| Qwen3-30B-A3B-Instruct-2507            | Function Calling | Qwen           | qwen3-30b-a3b-instruct-2507-FC                              |
| Qwen3-30B-A3B-Instruct-2507            | Function Calling | Self-hosted 💻 | Qwen/Qwen3-30B-A3B-Instruct-2507-FC                         |
| Qwen3-30B-A3B-Instruct-2507            | Prompt           | Qwen           | qwen3-30b-a3b-instruct-2507                                 |
| Qwen3-30B-A3B-Instruct-2507            | Prompt           | Self-hosted 💻 | Qwen/Qwen3-30B-A3B-Instruct-2507                            |
| Qwen3-4B-Instruct-2507                 | Function Calling | Self-hosted 💻 | Qwen/Qwen3-4B-Instruct-2507-FC                              |
| Qwen3-4B-Instruct-2507                 | Prompt           | Self-hosted 💻 | Qwen/Qwen3-4B-Instruct-2507                                 |
| Qwen3-4B-NoThink                       | Function Calling | Qwen           | qwen3-4b-nothink-FC                                         |
| Qwen3-4B-Think                         | Function Calling | Qwen           | qwen3-4b-think-FC                                           |
| QwQ-32B                                | Function Calling | Qwen           | qwq-32b-FC                                                  |
| QwQ-32B                                | Prompt           | Qwen           | qwq-32b                                                     |
| RZN-T                                  | Prompt           | Self-hosted 💻 | phronetic-ai/RZN-T                                          |
| Sky-T1-32B-Preview                     | Prompt           | Self-hosted 💻 | NovaSky-AI/Sky-T1-32B-Preview                               |
| ThinkAgent-1B                          | Function Calling | Self-hosted 💻 | ThinkAgents/ThinkAgent-1B                                   |
| ToolACE-2-8B                           | Prompt           | Self-hosted 💻 | Team-ACE/ToolACE-2-8B                                       |
| watt-tool-{8B,70B}                     | Prompt           | Self-hosted 💻 | watt-ai/watt-tool-{8B,70B}                                  |
| xiaoming-14B                           | Function Calling | Mininglamp     | xiaoming-14B                                                |
| xLAM-2-1b-fc-r                         | Function Calling | Self-hosted 💻 | Salesforce/xLAM-2-1b-fc-r                                   |
| xLAM-2-32b-fc-r                        | Function Calling | Self-hosted 💻 | Salesforce/xLAM-2-32b-fc-r                                  |
| xLAM-2-3b-fc-r                         | Function Calling | Self-hosted 💻 | Salesforce/xLAM-2-3b-fc-r                                   |
| xLAM-2-70b-fc-r                        | Function Calling | Self-hosted 💻 | Salesforce/Llama-xLAM-2-70b-fc-r                            |
| xLAM-2-8b-fc-r                         | Function Calling | Self-hosted 💻 | Salesforce/Llama-xLAM-2-8b-fc-r                             |

---

## Additional Requirements for Certain Models

- **Gemini Models:**
  For `Gemini` models, we use the Google AI Studio API for inference. Ensure you have set the `GOOGLE_API_KEY` in your `.env` file.

- **Nova Models (AWS Bedrock):**
  For `Nova` models, set your `AWS_SSO_PROFILE_NAME` in your `.env` file after completing the [AWS SSO token provider setup](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html). Make sure the necessary AWS Bedrock permissions are granted in the `us-east-1` region.

---

For more details and a summary of feature support across different models, see the [Berkeley Function Calling Leaderboard blog post](https://gorilla.cs.berkeley.edu/blogs/8_berkeley_function_calling_leaderboard.html#prompt).
