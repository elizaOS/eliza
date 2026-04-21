# Telegram Agent - Python

## Setup

```bash
pip install -r requirements.txt
export TELEGRAM_BOT_TOKEN="your-token"
export OPENAI_API_KEY="your-key"
python telegram_agent.py
```

Messages are routed to `runtime.message_service.handle_message()` for full pipeline processing.
