# Browser Use Example (Rust)

An autonomous ElizaOS agent that explores the web with curiosity, focusing on understanding quantum physics.

## Features

- **Fast Native Performance**: Built with Rust for speed
- **Autonomous Exploration**: Agent independently explores physics topics
- **Multiple Providers**: Supports Groq (fast/cheap) and OpenAI
- **CLI-Based**: Simple command-line interface

## Quick Start

### 1. Set API Key

```bash
# Option A: Groq (recommended - fast and cheap)
export GROQ_API_KEY=your_key

# Option B: OpenAI
export OPENAI_API_KEY=your_key
```

### 2. Build and Run

```bash
# Build
cargo build --release

# Run (explore random topic)
cargo run --release

# Explore specific topic
cargo run --release -- --topic "quantum entanglement"

# Enable autonomous mode
cargo run --release -- --autonomous --max-steps 5
```

## CLI Options

```
USAGE:
    browser-use-example [OPTIONS]

OPTIONS:
    --topic <TOPIC>      Specific topic to explore (default: random)
    --autonomous         Enable continuous autonomous exploration
    --max-steps <N>      Maximum exploration steps (default: 10)
    --verbose            Enable verbose logging
    --help, -h           Show this help message
```

## Example Output

```
════════════════════════════════════════════════════════════
  🔬 QuantumExplorer - Autonomous Browser Agent (Rust)
  Exploring the mysteries of quantum physics...
════════════════════════════════════════════════════════════

════════════════════════════════════════════════════════════
🔬 Exploring: wave-particle duality
════════════════════════════════════════════════════════════

📖 Initial exploration:
Wave-particle duality is one of the most fundamental and counterintuitive
concepts in quantum mechanics. It describes the phenomenon where quantum
entities such as electrons and photons exhibit both wave-like and 
particle-like properties...

📖 Step 2 exploration:
Building on wave-particle duality, let's explore the famous double-slit
experiment, which dramatically demonstrates this behavior...
```

## Topics the Agent Explores

- Wave-particle duality
- Quantum superposition
- Quantum entanglement
- Heisenberg uncertainty principle
- Schrödinger equation
- Quantum tunneling
- Double-slit experiment
- Quantum measurement problem

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              QuantumExplorer (Rust)                     │
├─────────────────────────────────────────────────────────┤
│  LlmClient                                              │
│    - Groq API (default)                                 │
│    - OpenAI API (fallback)                              │
├─────────────────────────────────────────────────────────┤
│  explore_topic()                                        │
│    - Initial exploration prompt                         │
│    - Follow-up deep dives                               │
├─────────────────────────────────────────────────────────┤
│  autonomous_exploration()                               │
│    - Random topic selection                             │
│    - Continuous exploration loop                        │
└─────────────────────────────────────────────────────────┘
```

## Dependencies

- `tokio` - Async runtime
- `reqwest` - HTTP client
- `serde` / `serde_json` - JSON serialization
- `rand` - Random topic selection
- `tracing` - Logging

## License

MIT
