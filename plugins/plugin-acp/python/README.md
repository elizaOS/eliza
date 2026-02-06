# elizaos-plugin-acp

Python implementation of the ACP (Agentic Commerce Protocol) plugin for elizaOS.

## Installation

```bash
pip install elizaos-plugin-acp
```

For development:

```bash
pip install -e ".[dev]"
```

## Usage

```python
import asyncio
from elizaos_plugin_acp import AcpClient, AcpClientConfig

async def main():
    # Create client from environment variables
    config = AcpClientConfig.from_env()
    client = AcpClient(config)
    
    # Create a checkout session
    session = await client.create_checkout_session({
        "currency": "USD",
        "line_items": [
            {
                "id": "item_123",
                "name": "Widget",
                "unit_amount": 1000,
                "quantity": 2
            }
        ],
        "buyer": {
            "email": "customer@example.com"
        }
    })
    
    print(f"Session ID: {session.id}")
    print(f"Status: {session.status}")
    print(f"Total: {session.totals}")

asyncio.run(main())
```

## Environment Variables

- `ACP_MERCHANT_BASE_URL` (required): Base URL of the merchant API
- `ACP_MERCHANT_API_KEY` (optional): API key for authentication
- `ACP_REQUEST_TIMEOUT` (optional): Request timeout in seconds (default: 30)
- `ACP_API_VERSION` (optional): API version (default: 2026-01-30)

## Running Tests

```bash
pytest
```

With coverage:

```bash
pytest --cov=elizaos_plugin_acp
```

## License

MIT
