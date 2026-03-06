# Browser Use Example (Python)

An autonomous elizaOS agent that explores the web with curiosity, focusing on understanding quantum physics.

## Features

- **Autonomous Exploration**: Agent independently browses physics education sites
- **Curiosity-Driven**: Follows related concepts from one topic to another
- **Knowledge Synthesis**: Extracts and explains complex physics concepts
- **Multiple Providers**: Supports Groq (fast/cheap), OpenAI, Anthropic

## Quick Start

### 1. Install Dependencies

```bash
# From repo root
pip install -e packages/python
pip install -e plugins/plugin-browser/python
pip install -e plugins/plugin-groq/python  # or plugin-openai
```

### 2. Set API Key

```bash
# Option A: Groq (recommended - fast and cheap)
export GROQ_API_KEY=your_key

# Option B: OpenAI
export OPENAI_API_KEY=your_key
```

### 3. Run

```bash
# Explore a random quantum physics topic
python run.py

# Explore specific topic
python run.py --topic "quantum entanglement"

# Enable autonomous mode (continuous exploration)
python run.py --autonomous

# With Groq provider explicitly
python run.py --provider groq --topic "wave-particle duality"
```

## CLI Options

```
Usage: python run.py [OPTIONS]

Options:
  --topic TEXT          Specific topic to explore (default: random)
  --provider {openai,groq,anthropic,auto}
                        Model provider (default: auto-detect)
  --autonomous          Enable continuous autonomous exploration
  --max-steps N         Maximum exploration steps (default: 10)
  --headless           Run browser in headless mode (default: True)
  --verbose            Enable verbose logging
```

## Example Output

```
============================================================
  🔬 QuantumExplorer - Autonomous Browser Agent
  Exploring the mysteries of quantum physics...
============================================================

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔬 Exploring: wave-particle duality
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📖 Agent response:
I navigated to Wikipedia's article on wave-particle duality. Here's what I discovered:

Wave-particle duality is a fundamental concept in quantum mechanics that proposes 
that every particle exhibits both wave and particle properties...

Related concepts to explore:
- Double-slit experiment
- De Broglie wavelength
- Quantum superposition
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
│                  QuantumExplorer Agent                  │
├─────────────────────────────────────────────────────────┤
│  Character: Curious AI physicist                        │
│  System: QUANTUM_EXPLORER_SYSTEM prompt                 │
├─────────────────────────────────────────────────────────┤
│  Plugins:                                               │
│    - Model Provider (Groq/OpenAI)                       │
│    - Browser Plugin (navigate, extract, click)          │
├─────────────────────────────────────────────────────────┤
│  runtime.message_service.handle_message()               │
└─────────────────────────────────────────────────────────┘
```

## Benchmark

For evaluating browser agents, see `benchmarks/mind2web/`:

```bash
python -m benchmarks.mind2web --sample --real-llm --provider groq
```

## License

MIT
