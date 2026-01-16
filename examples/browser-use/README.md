# Browser Use Example - QuantumExplorer

An autonomous ElizaOS agent that explores the web with curiosity, focusing on discovering new research in quantum physics.

## Shared Configuration

All three language implementations (TypeScript, Python, Rust) share a single character configuration file:

```
examples/browser-use/
├── character.json          # Shared character config (single source of truth)
├── typescript/server.ts    # TypeScript implementation
├── python/run.py           # Python implementation
└── rust/src/main.rs        # Rust implementation
```

### character.json Structure

```json
{
  "name": "QuantumExplorer",
  "bio": "Description of the AI researcher...",
  "system": "System prompt with research instructions...",
  "topics": ["wave-particle duality", "quantum entanglement", ...],
  "settings": { "AUTONOMY_MODE": "task" },
  "exploration": {
    "arxiv_base_url": "https://arxiv.org/search/?searchtype=all&query=",
    "initial_prompt_template": "Research mission: ...",
    "followup_prompt_template": "Continue your research on {topic}..."
  }
}
```

## Running the Examples

### Prerequisites

Set your API key (Groq recommended for speed):
```bash
export GROQ_API_KEY="your_key"
# or
export OPENAI_API_KEY="your_key"
```

### TypeScript

```bash
cd examples/browser-use/typescript
bun install
bun run server.ts
# Server runs at http://localhost:3333
```

### Python

```bash
cd examples/browser-use/python
pip install -e ../../../packages/python
pip install python-dotenv
python run.py --topic "quantum entanglement"
python run.py --autonomous --max-steps 5
```

### Rust

```bash
cd examples/browser-use/rust
cargo run --release -- --topic "quantum computing"
cargo run --release -- --autonomous --max-steps 5
```

## Customization

To customize the agent's behavior, edit `character.json`:

- **name**: Agent's display name
- **bio**: Short description for character profile
- **system**: Full system prompt defining behavior
- **topics**: List of research topics to explore
- **exploration.initial_prompt_template**: First message template (use `{topic}` and `{arxiv_url}`)
- **exploration.followup_prompt_template**: Follow-up message template (use `{topic}`)

Changes to `character.json` apply to all three language implementations.
