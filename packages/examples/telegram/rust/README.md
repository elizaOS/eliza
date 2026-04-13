# Telegram Agent - Rust

## Setup

```bash
cd telegram-agent
export TELEGRAM_BOT_TOKEN="your-token"
export OPENAI_API_KEY="your-key"
cargo run --release
```

Messages are routed to `runtime.message_service().handle_message()` for full pipeline processing.
