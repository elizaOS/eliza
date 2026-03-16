# elizaOS ICP Canister Example

Deploy an elizaOS AI agent as a canister on the Internet Computer (ICP). This example demonstrates how to run a fully decentralized AI agent with persistent memory, OpenAI integration via HTTP outcalls, and secure key management using vetKeys.

## Architecture

```
┌──────────────────┐     ┌─────────────────────────────────────────────┐
│                  │     │           Internet Computer                 │
│   Web Client     │────▶│  ┌─────────────────────────────────────┐   │
│   (Browser/CLI)  │◀────│  │         elizaOS Canister            │   │
│                  │     │  │  ┌─────────────┐  ┌──────────────┐  │   │
└──────────────────┘     │  │  │   Agent     │  │   Storage    │  │   │
                         │  │  │   Runtime   │  │  (Stable)    │  │   │
                         │  │  └──────┬──────┘  └──────────────┘  │   │
                         │  │         │                            │   │
                         │  │         ▼                            │   │
                         │  │  ┌─────────────┐  ┌──────────────┐  │   │
                         │  │  │  HTTP Out   │  │   VetKeys    │  │   │
                         │  │  │  (OpenAI)   │  │   (Crypto)   │  │   │
                         │  │  └──────┬──────┘  └──────────────┘  │   │
                         │  └─────────┼────────────────────────────┘   │
                         └────────────┼────────────────────────────────┘
                                      ▼
                         ┌────────────────────┐
                         │  Your API Gateway  │
                         │  (IPv6 + Auth)     │
                         └────────────────────┘
                                      ▼
                         ┌────────────────────┐
                         │    OpenAI API      │
                         └────────────────────┘
```

## Features

- **Decentralized Execution**: Your AI agent runs on the Internet Computer with no traditional servers
- **Persistent Memory**: Conversation history and memories survive canister upgrades using stable structures
- **OpenAI Integration**: HTTP outcalls to OpenAI via a secure gateway (API keys never stored on-chain)
- **DFINITY LLM Integration**: Free Llama 3.1 8B / Qwen3 32B via the DFINITY LLM canister
- **VetKeys Support**: Secure cryptographic key derivation for encryption and signing
- **elizaOS Compatible**: Types and patterns match the main elizaOS Rust implementation
- **elizaOS Sync Runtime**: Uses the new `sync` feature for environments without tokio
- **Multi-Room Support**: Separate conversation contexts with UUID-based identification

## elizaOS Sync Runtime

This example demonstrates elizaOS's new **sync runtime** feature, designed for environments that don't support tokio or async runtimes:

- **ICP Canisters** - Single-threaded WASM execution
- **Embedded Systems** - Resource-constrained environments
- **WASI Applications** - WebAssembly System Interface
- **Custom Runtimes** - Any environment needing synchronous execution

### Usage with elizaOS Sync Runtime

```rust
use elizaos::{SyncAgentRuntime, Character, DatabaseAdapterSync};
use crate::eliza_bridge::IcpElizaAdapter;

// Create a character
let character = Character {
    name: "MyAgent".to_string(),
    bio: Bio::Single("A helpful assistant".to_string()),
    system: Some("You are a helpful AI assistant.".to_string()),
    ..Default::default()
};

// Create ICP-backed database adapter
let adapter = IcpElizaAdapter::new("agent-id".to_string());

// Create the sync runtime
let runtime = SyncAgentRuntime::new(character, Some(Box::new(adapter)))?;
runtime.initialize()?;

// Register a model handler (using HTTP outcalls)
runtime.register_model("TEXT_LARGE", Box::new(|params| {
    // Call OpenAI via ICP HTTP outcall
    let response = OpenAIClient::new(gateway_url)
        .generate_text(&params["prompt"].as_str().unwrap_or(""), None)?;
    Ok(response)
}));

// Handle messages using the canonical elizaOS pattern
let mut message = Memory::message(entity_id, room_id, "Hello!");
let result = runtime.message_service().handle_message(&runtime, &mut message, None)?;
```

### Key Differences from Async Runtime

| Feature | Async Runtime | Sync Runtime |
|---------|--------------|--------------|
| Lock Type | `tokio::sync::RwLock` | `std::sync::RwLock` |
| Trait | `DatabaseAdapter` | `DatabaseAdapterSync` |
| Methods | `async fn` | `fn` |
| Service | `IMessageService` | `IMessageServiceSync` |
| Runtime | `AgentRuntime` | `SyncAgentRuntime` |

### Feature Flags

```toml
[dependencies]
elizaos = { version = "2.0", default-features = false, features = ["sync"] }

# Or for ICP-specific builds:
elizaos = { version = "2.0", default-features = false, features = ["icp"] }
```

## Prerequisites

### 1. DFINITY SDK (dfx)

```bash
# Install dfx
sh -ci "$(curl -fsSL https://internetcomputer.org/install.sh)"

# Verify installation
dfx --version
```

### 2. Rust Toolchain

```bash
# Install Rust if not already installed
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add WebAssembly target (required for ICP canisters)
rustup target add wasm32-unknown-unknown

# Verify installation
rustc --version
cargo --version
```

### 3. (Optional) API Gateway for OpenAI

To use OpenAI, you need a gateway that:
- Is accessible over IPv6 (ICP requirement)
- Injects the `Authorization: Bearer <API_KEY>` header server-side
- **Never exposes your API key to the canister**

See [Setting Up OpenAI Gateway](#setting-up-openai-gateway) below.

## Quick Start

### 1. Navigate to the Example

```bash
cd examples/icp
```

### 2. Start Local Replica

```bash
# Start the local Internet Computer replica in the background
dfx start --background --clean
```

### 3. Deploy the Canister

```bash
# Deploy to local replica
dfx deploy

# The canister ID will be displayed, e.g.:
# Deployed canisters:
#   eliza_icp_backend: rrkah-fqaaa-aaaaa-aaaaq-cai
```

### 4. Initialize the Agent

```bash
# Initialize with default character
dfx canister call eliza_icp_backend init_agent '(null)'

# Or initialize with custom character (matching elizaOS Character type)
dfx canister call eliza_icp_backend init_agent '(opt record {
  name = "Alice";
  bio = "A helpful AI assistant specializing in Web3 and ICP development.";
  system = opt "You are Alice, an expert in Internet Computer development. Give direct, substantive answers.";
  personality_traits = vec { "helpful"; "technical"; "friendly"; "direct" };
  knowledge_base = vec { "ICP"; "canisters"; "Rust"; "Web3" };
  message_examples = vec {};
})'
```

### 5. Chat with the Agent

```bash
# Send a message (follows elizaOS Content -> Memory::new pattern)
dfx canister call eliza_icp_backend chat '(record {
  message = "Hello! Tell me about yourself.";
  user_id = null;
  room_id = null;
})'

# Example response:
# (variant { Ok = record {
#   message = "Hello! I'm Alice, A helpful AI assistant...";
#   room_id = "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";
#   message_id = "ffffffff-1111-4222-3333-444444444444";
#   timestamp = 1_705_123_456_789_000_000 : nat64;
# }})
```

### 6. Check Health Status

```bash
dfx canister call eliza_icp_backend health
```

## OpenAI Integration

### Security Model

**NEVER store API keys in the canister.** ICP canisters are transparent - all state can be read. Instead:

1. Deploy your own API gateway that:
   - Accepts requests from your canister
   - Injects the OpenAI API key server-side
   - Is accessible over IPv6 (required by ICP)

2. Configure the canister to use your gateway:

```bash
dfx canister call eliza_icp_backend configure_openai '(record {
  gateway_url = "https://your-gateway.example.com/v1/chat/completions";
  model = "gpt-5-mini";
  temperature = 0.7;
  max_tokens = opt 1024;
})'
```

### Setting Up OpenAI Gateway

Example gateway options:

1. **Cloudflare Workers** (recommended - native IPv6):
   ```javascript
   export default {
     async fetch(request) {
       const url = new URL(request.url);
       url.host = 'api.openai.com';
       
       const headers = new Headers(request.headers);
       headers.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
       
       return fetch(url, {
         method: request.method,
         headers,
         body: request.body,
       });
     }
   };
   ```

2. **AWS API Gateway + Lambda** (with IPv6 VPC)

3. **Self-hosted with nginx** (dual-stack)

### Check OpenAI Status

```bash
# Verify OpenAI is configured
dfx canister call eliza_icp_backend is_openai_enabled

# If false, configure with your gateway URL
```

## VetKeys (Secure Key Derivation)

VetKeys allow secure cryptographic key derivation on ICP:

```bash
# Get a user-specific encryption key
# The key is encrypted with your transport public key
dfx canister call eliza_icp_backend get_user_encryption_key '(blob "YOUR_TRANSPORT_PUBLIC_KEY")'

# Get the canister's vetKD public key
dfx canister call eliza_icp_backend get_vetkd_public_key
```

Use cases:
- Encrypt user-specific data
- Derive session keys
- Create user-controlled encryption

**Note**: VetKeys are only available on specific ICP subnets. Check [DFINITY docs](https://docs.internetcomputer.org/references/vetkeys-overview) for availability.

## API Reference

### Agent Management

| Method | Type | Description |
|--------|------|-------------|
| `init_agent(config?)` | Update | Initialize agent with optional character |
| `configure_openai(config)` | Update | Configure OpenAI gateway |
| `update_character(config)` | Update | Update agent character |
| `get_agent_state()` | Query | Get current agent state |

### Chat Interface (elizaOS Pattern)

| Method | Type | Description |
|--------|------|-------------|
| `chat(request)` | Update | Content -> Memory::new -> process -> response |
| `get_conversation_history(room_id, count?)` | Query | Get memories for a room |

### Memory Management

| Method | Type | Description |
|--------|------|-------------|
| `create_memory(entity_id, room_id, text, type?)` | Update | Store a memory |
| `get_memories(room_id?, count?)` | Query | Query memories |
| `delete_memory(id)` | Update | Delete a memory |

### VetKeys

| Method | Type | Description |
|--------|------|-------------|
| `get_user_encryption_key(transport_key)` | Update | Derive user encryption key |
| `get_vetkd_public_key()` | Update | Get canister's vetKD public key |

### Diagnostics

| Method | Type | Description |
|--------|------|-------------|
| `health()` | Query | Get canister health |
| `cycles_balance()` | Query | Get cycles balance |
| `is_openai_enabled()` | Query | Check OpenAI configuration |

## Project Structure

```
examples/icp/
├── dfx.json                           # DFX project configuration
├── Cargo.toml                         # Workspace manifest
├── README.md                          # This file
├── scripts/
│   └── setup.sh                       # Setup helper script
└── src/
    └── eliza_icp_backend/
        ├── Cargo.toml                 # Canister dependencies
        ├── eliza_icp_backend.did      # Candid interface
        └── src/
            ├── lib.rs                 # Main canister (chat, agent mgmt)
            ├── types.rs               # Types (Content, Memory, UUID)
            ├── storage.rs             # ICP stable storage adapter
            ├── http_outcalls.rs       # OpenAI HTTP integration
            └── vetkeys.rs             # VetKeys integration
```

## How It Works

The canister follows the elizaOS chat example pattern:

```rust
// 1. User sends message
let request = ChatRequest { message: "Hello!", .. };

// 2. Create Content (like elizaOS Content { text: Some(...) })
let content = Content::text(&request.message);

// 3. Create Memory (like elizaOS Memory::new(user_id, room_id, content))
let memory = Memory::new(user_id, room_id, content);

// 4. Store user message
IcpStorageAdapter::create_memory(memory)?;

// 5. Generate response (OpenAI or pattern matching)
let response = generate_response(&character, &message, &history).await;

// 6. Store agent response as memory
let agent_memory = Memory::new(agent_id, room_id, Content::text(&response));
IcpStorageAdapter::create_memory(agent_memory)?;

// 7. Return response
Ok(ChatResponse { message: response, .. })
```

## Deploying to Mainnet

### 1. Get Cycles

```bash
# Convert ICP to cycles or use the faucet
dfx ledger --network ic balance
```

### 2. Deploy

```bash
dfx deploy --network ic
```

### 3. Initialize

```bash
dfx canister --network ic call eliza_icp_backend init_agent '(null)'
```

## Troubleshooting

### "OpenAI request failed"

- Verify your gateway URL is correct and IPv6 accessible
- Check gateway logs for errors
- Ensure gateway is injecting Authorization header

### "VetKey error"

- VetKeys may not be available on your subnet
- Check DFINITY documentation for vetKD-enabled subnets

### Build Errors

```bash
# Ensure wasm target is installed
rustup target add wasm32-unknown-unknown

# Clean and rebuild
cargo clean
dfx build
```

## On-Chain LLM (Optional)

Run inference fully on-chain without any external API calls using `llama_cpp_canister`.

### Setup

```bash
# 1. Clone llama_cpp_canister
cd examples/icp
git clone https://github.com/onicai/llama_cpp_canister.git

# 2. Deploy the LLM canister
cd llama_cpp_canister
dfx deploy llama_cpp --network local

# 3. Add cycles
dfx ledger fabricate-cycles --canister llama_cpp --t 20

# 4. Download a small model (SmolLM2-135M recommended for ICP)
mkdir -p models/SmolLM2
wget -O models/SmolLM2/SmolLM2-135M-Instruct-Q8_0.gguf \
  "https://huggingface.co/tensorblock/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q8_0.gguf"

# 5. Create Python venv and install dependencies
python3 -m venv .venv && source .venv/bin/activate
pip install ic-py icpp-pro requests

# 6. Upload model to canister (~5-10 minutes)
python -m scripts.upload --network local --canister llama_cpp \
  --canister-filename models/model.gguf --filetype gguf \
  models/SmolLM2/SmolLM2-135M-Instruct-Q8_0.gguf

# 7. Load model
dfx canister call llama_cpp load_model '(record {
  args = vec { "--model"; "models/model.gguf"; "--cache-type-k"; "f16" }
})'

# 8. Set max tokens
dfx canister call llama_cpp set_max_tokens '(record {
  max_tokens_query = 1 : nat64;
  max_tokens_update = 40 : nat64
})'

# 9. Open access for inter-canister calls
dfx canister call llama_cpp set_access '(record { level = 1 : nat16 })'
```

### Configure elizaOS to Use On-Chain LLM

```bash
# Get the llama_cpp canister ID
LLM_CANISTER=$(dfx canister id llama_cpp)

# Configure elizaOS backend
dfx canister call eliza_icp_backend configure_onchain_llm "(record {
  canister_id = principal \"$LLM_CANISTER\";
  model_name = \"SmolLM2-135M\";
  max_tokens = 256 : nat32;
  temperature = 0.7 : float32;
  cache_type_k = \"f16\";
  system_prompt = opt \"You are a helpful AI assistant.\";
})"

# Switch to on-chain mode
dfx canister call eliza_icp_backend set_inference_mode '(variant { OnChainLLM })'
```

### Four Inference Modes

| Mode | Command | Speed | Quality |
|------|---------|-------|---------|
| Classic | `set_inference_mode '(variant { ElizaClassic })'` | ~2s | Pattern matching |
| OpenAI | `set_inference_mode '(variant { OpenAI })'` | ~5s | Best (GPT-4o) |
| On-Chain | `set_inference_mode '(variant { OnChainLLM })'` | ~50s | Good (fully decentralized) |
| DFINITY LLM | `set_inference_mode '(variant { DfinityLLM })'` | ~3-8s | Llama 3.1 8B / Qwen3 32B (FREE, managed by DFINITY) |

See `ON_CHAIN_LLM_PLAN.md` for detailed architecture and configuration options.

## DFINITY LLM (Recommended for speed)

DFINITY provides a managed LLM canister (Llama 3.1 8B / Qwen3 32B). It is **fast and free**.

**Note**: This is currently available on **mainnet** only. Local replicas will fall back to ELIZA Classic if the call fails.

### Switch to DFINITY LLM

```bash
dfx canister call eliza_icp_backend set_inference_mode '(variant { DfinityLLM })'
```

## Resources

- [Internet Computer Documentation](https://internetcomputer.org/docs/)
- [VetKeys Overview](https://docs.internetcomputer.org/references/vetkeys-overview)
- [HTTP Outcalls](https://internetcomputer.org/docs/building-apps/network-features/using-http/https-outcalls/overview)
- [llama_cpp_canister](https://github.com/onicai/llama_cpp_canister) - On-chain LLM inference
- [elizaOS Documentation](https://elizaos.ai/docs)
- [elizaOS Rust Chat Example](../chat/rust/)

## License

MIT License - see the main elizaOS repository for details.
