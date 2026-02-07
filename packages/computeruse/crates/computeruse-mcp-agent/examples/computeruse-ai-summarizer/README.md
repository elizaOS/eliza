# ComputerUse AI Summarizer

A global hotkey tool that captures your desktop UI context and optionally summarizes it with Ollama for AI assistance.

## 🚀 Features

- **Global Hotkey**: Press `Ctrl+Alt+J` to instantly capture UI context
- **Two Modes**: 
  - **Basic Mode**: Copy raw UI tree to clipboard
  - **AI Mode**: Summarize UI context using local Ollama models
- **Cross-platform**: Works on Windows, macOS, and Linux
- **Privacy-first**: Everything runs locally, no data sent to external services

## 📋 Prerequisites

1. **Rust toolchain** installed (https://rustup.rs/)
2. **Ollama** installed and running (https://ollama.ai/) - only required for AI mode
3. **A compatible model** downloaded in Ollama (e.g., `ollama pull gemma3:1b`)

## 🛠️ Installation

### Option 1: Install as Global CLI (Recommended)

Install with short name from repository:
```bash
cargo install --git https://github.com/mediar-ai/computeruse --bin ai-summarizer computeruse-mcp-agent
```

Or install from local source:
```bash
git clone https://github.com/mediar-ai/computeruse.git
cd computeruse
cargo install --path computeruse-mcp-agent --bin ai-summarizer
```

After installation, run from anywhere:
```bash
ai-summarizer --help
```

Or install with full name:
```bash
cargo install --git https://github.com/mediar-ai/computeruse --example computeruse-ai-summarizer computeruse-mcp-agent
computeruse-ai-summarizer --help
```

### Option 2: Build from Source

1. **Clone the repository**:
   ```bash
   git clone https://github.com/mediar-ai/computeruse.git
   cd computeruse
   ```

2. **Build the computeruse-mcp-agent first** (required dependency):
   ```bash
   cargo build --release --bin computeruse-mcp-agent
   ```

3. **Build the AI summarizer example**:
   ```bash
   cargo build --example computeruse-ai-summarizer --release
   ```

## 🎯 Usage

### Basic Mode (No AI)
Captures the UI tree and copies it directly to clipboard:

```bash
# If installed with short name
ai-summarizer

# If installed with full name
computeruse-ai-summarizer

# If built from source
./target/release/examples/computeruse-ai-summarizer
```

### AI Mode with Custom Model
Uses Ollama to summarize the UI context:

```bash
# If installed with short name
ai-summarizer \
  --ai-mode \
  --model "gemma3:8b" \
  --system-prompt "You are a helpful UI assistant. Summarize what's on screen."

# If installed with full name
computeruse-ai-summarizer \
  --ai-mode \
  --model "gemma3:8b" \
  --system-prompt "You are a helpful UI assistant. Summarize what's on screen."

# If built from source
./target/release/examples/computeruse-ai-summarizer \
  --ai-mode \
  --model "gemma3:8b" \
  --system-prompt "You are a helpful UI assistant. Summarize what's on screen."
```

### Custom Hotkey
Change the trigger combination:

```bash
# If installed as global CLI
computeruse-ai-summarizer \
  --hotkey "ctrl+shift+s" \
  --ai-mode

# If built from source
./target/release/examples/computeruse-ai-summarizer \
  --hotkey "ctrl+shift+s" \
  --ai-mode
```

## ⚙️ Configuration Options

| Option | Short | Default | Description |
|--------|-------|---------|-------------|
| `--system-prompt` | `-s` | *[Long default prompt]* | Custom prompt for AI summarization |
| `--model` | `-m` | `gemma3:1b` | Ollama model to use for summarization |
| `--hotkey` | `-h` | `ctrl+alt+j` | Global hotkey combination |
| `--ai-mode` | `-a` | `false` | Enable AI summarization via Ollama |

## 🔧 Environment Variables

- `LOG_LEVEL`: Set logging level (`error`, `warn`, `info`, `debug`)
- `COMPUTERUSE_AGENT_PATH`: Custom path to computeruse-mcp-agent binary

## 📖 How It Works

1. **Press the hotkey** (default: `Ctrl+Alt+J`)
2. **UI capture**: Tool detects the focused window and captures its accessibility tree
3. **Processing**:
   - **Basic mode**: Raw UI tree copied to clipboard
   - **AI mode**: UI tree sent to Ollama for summarization
4. **Result**: Processed content available in your clipboard

## 💡 Example Workflow

1. **Start the tool**:
   ```bash
   # If installed with short name
   ai-summarizer --ai-mode --model "gemma3:8b"
   
   # If installed with full name
   computeruse-ai-summarizer --ai-mode --model "gemma3:8b"
   
   # If built from source
   ./target/release/examples/computeruse-ai-summarizer --ai-mode --model "gemma3:8b"
   ```

2. **Navigate to any application** (browser, text editor, etc.)

3. **Press `Ctrl+Alt+J`** - you'll see a log message confirming capture

4. **Paste the result** into your AI chat or text editor to get contextual assistance

## 🐛 Troubleshooting

### "Failed to capture context"
- Ensure `computeruse-mcp-agent` is built and in the expected path
- Check that the focused window has accessible UI elements

### "Failed to summarize with Ollama"
- Verify Ollama is running: `ollama list`
- Ensure the specified model is available: `ollama pull gemma3:1b`
- Check Ollama service status

### Hotkey not working
- Ensure no other applications are using the same key combination
- Try running with elevated permissions if needed
- Check the logs for keyboard event detection

## 🔧 Development

### Running with Debug Logs
```bash
# If installed globally
LOG_LEVEL=debug computeruse-ai-summarizer --ai-mode

# If built from source
LOG_LEVEL=debug ./target/release/examples/computeruse-ai-summarizer --ai-mode
```

### Building from Source
```bash
# Build the MCP agent (dependency)
cargo build --release --bin computeruse-mcp-agent

# Build the summarizer
cargo build --example computeruse-ai-summarizer --release
```

### Installing as CLI
```bash
# Install with custom short name 'ai-summarizer'
cargo install --path computeruse-mcp-agent --bin ai-summarizer

# Or install the full example name
cargo install --path computeruse-mcp-agent --example computeruse-ai-summarizer --force

# Or create an alias for a shorter command
echo 'alias ais="computeruse-ai-summarizer"' >> ~/.bashrc  # Linux/macOS
```

## 📁 Project Structure

```
computeruse-mcp-agent/examples/computeruse-ai-summarizer/
├── src/
│   ├── main.rs      # Main application logic
│   ├── utils.rs     # CLI arguments & logging
│   ├── client.rs    # MCP client integration
│   └── ollama.rs    # Ollama API integration
└── README.md        # This file
```

## 🤝 Contributing

Contributions are welcome! Please check the main [CONTRIBUTING.md](../../../CONTRIBUTING.md) for guidelines.

## 📄 License

This project is licensed under the same license as the main ComputerUse project. 