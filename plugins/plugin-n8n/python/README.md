# elizaOS N8n Plugin - Python

AI-powered plugin creation for ElizaOS using Claude models.

## Installation

```bash
pip install elizaos-plugin-n8n
```

## Quick Start

```python
import asyncio
from elizaos_plugin_n8n import N8nConfig, PluginCreationClient, PluginSpecification

async def main():
    # Create configuration from environment
    config = N8nConfig.from_env()

    # Create client
    async with PluginCreationClient(config) as client:
        # Define plugin specification
        spec = PluginSpecification(
            name="@elizaos/plugin-weather",
            description="Weather information plugin",
            actions=[
                {
                    "name": "getWeather",
                    "description": "Get current weather for a location",
                }
            ],
        )

        # Create plugin
        job_id = await client.create_plugin(spec)
        print(f"Job started: {job_id}")

        # Check status
        job = client.get_job_status(job_id)
        print(f"Status: {job.status}")

asyncio.run(main())
```

## Configuration

Set the following environment variables:

- `ANTHROPIC_API_KEY` (required): Your Anthropic API key
- `PLUGIN_DATA_DIR` (optional): Directory for plugin workspace
- `CLAUDE_MODEL` (optional): Model to use (default: claude-3-opus-20240229)

## API Reference

### N8nConfig

Configuration for the plugin creation service.

```python
config = N8nConfig(
    api_key="your-api-key",
    model=ClaudeModel.OPUS_3,
    data_dir=Path("./data"),
)
```

### PluginCreationClient

Main client for creating plugins.

```python
client = PluginCreationClient(config)

# Create a plugin
job_id = await client.create_plugin(spec)

# Get job status
job = client.get_job_status(job_id)

# Cancel a job
client.cancel_job(job_id)

# Get all jobs
jobs = client.get_all_jobs()

# Cleanup old jobs
count = client.cleanup_old_jobs(days=7)
```

### PluginSpecification

Define your plugin specification:

```python
spec = PluginSpecification(
    name="@scope/plugin-name",
    description="Plugin description",
    version="1.0.0",
    actions=[
        ActionSpecification(
            name="actionName",
            description="Action description",
        )
    ],
    providers=[
        ProviderSpecification(
            name="providerName",
            description="Provider description",
        )
    ],
    services=[
        ServiceSpecification(
            name="ServiceName",
            description="Service description",
        )
    ],
)
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_n8n

# Linting
ruff check .
ruff format .
```

## License

MIT



