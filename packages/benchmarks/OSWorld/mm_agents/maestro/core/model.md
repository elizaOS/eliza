# Supported Model Providers and Model Lists

## LLM Model Providers

### 1. OpenAI

**Provider**

- `openai`

**Supported Models:**

- `gpt-5` Window: 400,000  Max Output Tokens: 128,000
- `gpt-5-mini` Window: 400,000  Max Output Tokens: 128,000
- `gpt-4.1-nano` Window: 400,000  Max Output Tokens: 128,000
- `gpt-4.1` Window: 1,047,576   Max Output Tokens: 32,768
- `gpt-4.1-mini`  Window: 1,047,576   Max Output Tokens: 32,768
- `gpt-4.1-nano`   Window: 1,047,576   Max Output Tokens: 32,768
- `gpt-4o`   Window: 128,000   Max Output Tokens: 16,384 
- `gpt-4o-mini`   Window: 128,000   Max Output Tokens: 16,384 
- `o1`   Window: 200,000   Max Output Tokens: 100,000 
- `o1-pro`   Window: 200,000   Max Output Tokens: 100,000 
- `o1-mini`   Window: 200,000   Max Output Tokens: 100,000 
- `o3`   Window: 200,000   Max Output Tokens: 100,000 
- `o3-pro`   Window: 200,000   Max Output Tokens: 100,000 
- `o3-mini`    Window: 200,000   Max Output Tokens: 100,000 
- `o4-mini`    Window: 200,000   Max Output Tokens: 100,000 

**Embedding Models:**

- `text-embedding-3-small`
- `text-embedding-3-large`
- `text-embedding-ada-002`

📚 **Reference Link:** <https://platform.openai.com/docs/pricing>

---

### 2. Anthropic Claude

**Provider**

- `anthropic`

**Supported Models:**

- `claude-opus-4-1-20250805`  Context window: 200K  Max output: 32000
- `claude-opus-4-20250514`   Context window: 200K  Max output: 32000
- `claude-sonnet-4-20250514`  Context window: 200K  Max output: 64000
- `claude-3-7-sonnet-20250219`   Context window: 200K  Max output: 64000
- - `claude-3-5-sonnet-20240620`   Context window: 200K  Max output: 64000
- `claude-3-5-haiku-20241022`    Context window: 200K  Max output: 8192

📚 **Reference Link:** <https://www.anthropic.com/api>

---

### 3. AWS Bedrock

**Provider**

- `bedrock`


**Supported Claude Models:**

- `Claude-Opus-4`
- `Claude-Sonnet-4`
- `Claude-Sonnet-3.7`
- `Claude-Sonnet-3.5`

📚 **Reference Link:** <https://aws.amazon.com/bedrock/>

---

### 4. Google Gemini

**Provider**

- `gemini`

**Supported Models:**

- `gemini-2.5-pro` in: 1,048,576  out: 65536
- `gemini-2.5-flash`  in: 1,048,576  out: 65536
- `gemini-2.0-flash` in: 1,048,576  out: 8192
- `gemini-1.5-pro`  in: 2,097,152  out: 8192
- `gemini-1.5-flash` in: 1,048,576  out: 8192

**Embedding Models:**

- `gemini-embedding-001`

📚 **Reference Link:** <https://ai.google.dev/gemini-api/docs/pricing>

---

### 5. Groq

**Provider**

- `groq`

**Supported Models:**

- `Kimi-K2-Instruct`
- `Llama-4-Scout-17B-16E-Instruct`
- `Llama-4-Maverick-17B-128E-Instruct`
- `Llama-Guard-4-12B`
- `DeepSeek-R1-Distill-Llama-70B`
- `Qwen3-32B`
- `Llama-3.3-70B-Instruct`

📚 **Reference Link:** <https://groq.com/pricing>

---

### 6. Monica (Proxy Platform)

**Provider**

- `monica`

**OpenAI Models:**

- `gpt-4.1`
- `gpt-4.1-mini`
- `gpt-4.1-nano`
- `gpt-4o-2024-11-20`
- `gpt-4o-mini-2024-07-18`
- `o4-mini`
- `o3`

**Anthropic Claude Models:**

- `claude-opus-4-20250514`
- `claude-sonnet-4-20250514`
- `claude-3-7-sonnet-latest`
- `claude-3-5-sonnet-20241022`
- `claude-3-5-sonnet-20240620`
- `claude-3-5-haiku-20241022`


**Google Gemini Models:**

- `gemini-2.5-pro-preview-03-25`
- `gemini-2.5-flash-lite`
- `gemini-2.5-flash-preview-05-20`
- `gemini-2.0-flash-001`
- `gemini-1.5-pro-002`
- `gemini-1.5-flash-002`

**DeepSeek Models:**

- `deepseek-reasoner`
- `deepseek-chat`

**Meta Llama Models:**

- `Llama-4-Scout-17B-16E-Instruct`   Context length: 10M tokens
- `Llama-4-Maverick-17B-128E-Instruct `   Context length: 1M tokens
- `llama-3.3-70b-instruct`
- `llama-3-70b-instruct`
- `llama-3.1-405b-instruct`

**xAI Grok Models:**

- `grok-3-beta`
- `grok-beta`

📚 **Reference Link:** <https://platform.monica.im/docs/en/models-and-pricing>

---

### 7. OpenRouter (Proxy Platform)

**Provider**

- `openrouter`

**OpenAI Models:**

- `gpt-4.1`
- `gpt-4.1-mini`
- `o1`
- `o1-pro`
- `o1-mini`
- `o3`
- `o3-pro`
- `o3-mini`
- `o4-mini`

**xAI Grok Models:**

- `grok-4`  Total Context: 256K   Max Output: 256K
- `grok-3`
- `grok-3-mini`

**Anthropic Claude Models:**

- `claude-opus-4`
- `claude-sonnet-4`

**Google Gemini Models:**

- `gemini-2.5-flash`
- `gemini-2.5-pro`

📚 **Reference Link:** <https://openrouter.ai/models>

---

### 8. Azure OpenAI

**Provider**

- `azure`


**Supported Models:**

- `gpt-4.1`
- `gpt-4.1-mini`
- `gpt-4.1-nano`
- `o1`
- `o3`
- `o4-mini`

📚 **Reference Link:** <https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/>

---

### 9. Lybic AI

**Provider:**

- `lybic`

**Supported Models:**

- `gpt-5`
- `gpt-4.1`
- `gpt-4.1-mini`
- `gpt-4.1-nano`
- `gpt-4.5-preview`
- `gpt-4o`
- `gpt-4o-realtime-preview`
- `gpt-4o-mini`
- `o1`
- `o1-pro`
- `o1-mini`
- `o3`
- `o3-pro`
- `o3-mini`
- `o4-mini`

**Note:** Lybic AI provides OpenAI-compatible API endpoints with the same model names and pricing structure.

📚 **Reference Link:** <https://aigw.lybicai.com/>

---

### 10. DeepSeek

**Provider**

- `deepseek`

**Supported Models:**

- `deepseek-chat`  Context length: 128K, Output length: Default 4K, Max 8K
- `deepseek-reasoner`  Context length: 128K, Output length: Default 32K, Max 64K

📚 **Reference Link:** <https://platform.deepseek.com/>

---

### 11. Alibaba Cloud Qwen

**Supported Models:**

- `qwen-max-latest`  Context window: 32,768  Max input token length: 30,720  Max generation token length: 8,192
- `qwen-plus-latest`  Context window: 131,072  Max input token length: 98,304 (thinking)  Max generation token length: 129,024  Max output: 16,384
- `qwen-turbo-latest`  Context window: 1,000,000  Max input token length: 1,000,000  Max generation token length: 16,384
- `qwen-vl-max-latest` (Grounding)  Context window: 131,072  Max input token length: 129,024  Max generation token length: 8,192
- `qwen-vl-plus-latest` (Grounding)  Context window: 131,072  Max input token length: 129,024  Max generation token length: 8,192

**Embedding Models:**

- `text-embedding-v4`
- `text-embedding-v3`

📚 **Reference Link:** <https://bailian.console.aliyun.com/?tab=doc#/doc/?type=model&url=https%3A%2F%2Fhelp.aliyun.com%2Fdocument_detail%2F2840914.html&renderType=iframe>

---

### 12. ByteDance Doubao

**Supported Models:**

- `doubao-seed-1-6-flash-250615`  Context window: 256k  Max input token length: 224k  Max generation token length: 32k  Max thinking content token length: 32k
- `doubao-seed-1-6-thinking-250715`  Context window: 256k  Max input token length: 224k  Max generation token length: 32k  Max thinking content token length: 32k
- `doubao-seed-1-6-250615` Context window: 256k  Max input token length: 224k  Max generation token length: 32k  Max thinking content token length: 32k
- `doubao-1.5-vision-pro-250328` (Grounding)  Context window: 128k  Max input token length: 96k   Max generation token length: 16k  Max thinking content token length: 32k
- `doubao-1-5-thinking-vision-pro-250428` (Grounding)  Context window: 128k  Max input token length: 96k  Max generation token length: 16k  Max thinking content token length: 32k
- `doubao-1-5-ui-tars-250428` (Grounding)  Context window: 128k  Max input token length: 96k  Max generation token length: 16k  Max thinking content token length: 32k

**Embedding Models:**

- `doubao-embedding-large-text-250515`
- `doubao-embedding-text-240715`

📚 **Reference Link:** <https://console.volcengine.com/ark/region:ark+cn-beijing/model?vendor=Bytedance&view=LIST_VIEW>

---

### 13. Zhipu GLM

**Supported Models:**

- `GLM-4.5`  Max in: 128k Max output: 0.2K
- `GLM-4.5-X`  Max in: 128k  Max output: 0.2K
- `GLM-4.5-Air` Max in: 128k  Max output: 0.2K
- `GLM-4-Plus`
- `GLM-4-Air-250414`
- `GLM-4-AirX` (Grounding)
- `GLM-4V-Plus-0111` (Grounding)

**Embedding Models:**

- `Embedding-3`
- `Embedding-2`

📚 **Reference Link:** <https://open.bigmodel.cn/pricing>

---

### 14. SiliconFlow

**Supported Models:**

- `Kimi-K2-Instruct`   Context Length: 128K
- `DeepSeek-V3`
- `DeepSeek-R1`
- `Qwen3-32B`

📚 **Reference Link:** <https://cloud.siliconflow.cn/sft-d1pi8rbk20jc73c62gm0/models>

---

## 🔤 Dedicated Embedding Providers

### 15. Jina AI

**Embedding Models:**

- `jina-embeddings-v4`
- `jina-embeddings-v3`

📚 **Reference Link:** <https://jina.ai/embeddings>

---

## 🔍 AI Search Engines

### 16. Bocha AI

**Service Type:** AI Research & Search

📚 **Reference Link:** <https://open.bochaai.com/overview>

---

### 17. Exa

**Service Type:** AI Research & Search

**Pricing Model:**

- $5.00 / 1k agent searches
- $5.00 / 1k exa-research agent page reads
- $10.00 / 1k exa-research-pro agent page reads
- $5.00 / 1M reasoning tokens

📚 **Reference Link:** <https://dashboard.exa.ai/home>
