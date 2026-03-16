# Feishu/Lark Plugin for elizaOS (Python)

Python implementation of the Feishu/Lark plugin for elizaOS agents.

## Installation

```bash
pip install elizaos-plugin-feishu
```

## Usage

```python
from elizaos_plugin_feishu import FeishuService, FeishuConfig

# Create configuration
config = FeishuConfig.from_env()

# Or create manually
config = FeishuConfig(
    app_id="cli_xxx",
    app_secret="your-app-secret",
    domain="feishu",  # or "lark" for global
)

# Create and start service
service = FeishuService(config)
await service.start()

# Send a message
await service.send_message(
    chat_id="oc_xxx",
    content=FeishuContent(text="Hello from elizaOS!")
)

# Stop service
await service.stop()
```

## Configuration

Environment variables:

- `FEISHU_APP_ID`: Application ID (required)
- `FEISHU_APP_SECRET`: Application secret (required)
- `FEISHU_DOMAIN`: "feishu" or "lark" (default: "feishu")
- `FEISHU_ALLOWED_CHATS`: JSON array of allowed chat IDs

## License

MIT
