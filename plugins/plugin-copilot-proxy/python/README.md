# elizaOS Copilot Proxy Plugin (Python)

Python implementation of the Copilot Proxy model provider plugin for elizaOS.

## Features

- OpenAI-compatible API client for Copilot Proxy
- Support for text generation (small and large models)
- JSON object generation with automatic parsing
- Health check functionality
- Configurable timeouts and model parameters
- Async/await support

## Installation

```bash
pip install elizaos-plugin-copilot-proxy
```

## Usage

```python
import asyncio
from elizaos_plugin_copilot_proxy import CopilotProxyPlugin

async def main():
    # Create plugin (uses environment variables or defaults)
    plugin = CopilotProxyPlugin()
    
    async with plugin:
        # Generate text
        response = await plugin.generate_text_large("What is 2+2?")
        print(response)
        
        # Generate JSON object
        obj = await plugin.generate_object_small("Create a JSON object with a greeting")
        print(obj)

asyncio.run(main())
```

## Environment Variables

- `COPILOT_PROXY_BASE_URL` - Base URL for the proxy server (default: `http://localhost:3000/v1`)
- `COPILOT_PROXY_ENABLED` - Enable/disable the plugin (default: `true`)
- `COPILOT_PROXY_SMALL_MODEL` - Small model ID (default: `gpt-5-mini`)
- `COPILOT_PROXY_LARGE_MODEL` - Large model ID (default: `gpt-5.1`)
- `COPILOT_PROXY_TIMEOUT_SECONDS` - Request timeout (default: `120`)
- `COPILOT_PROXY_MAX_TOKENS` - Maximum tokens (default: `8192`)
- `COPILOT_PROXY_CONTEXT_WINDOW` - Context window size (default: `128000`)

## License

MIT
