# elizaOS BlueSky Plugin (Python)

Python implementation of the BlueSky plugin for elizaOS using the AT Protocol.

## Installation

```bash
pip install elizaos-plugin-bluesky
```

## Usage

```python
from elizaos_plugin_bluesky import BlueSkyClient, BlueSkyConfig

# Create configuration
config = BlueSkyConfig(
    handle="your-handle.bsky.social",
    password="your-app-password",
)

# Or load from environment
config = BlueSkyConfig.from_env()

# Create client
async with BlueSkyClient(config) as client:
    # Authenticate
    await client.authenticate()

    # Create a post
    from elizaos_plugin_bluesky import CreatePostRequest, CreatePostContent

    request = CreatePostRequest(
        content=CreatePostContent(text="Hello from Python!")
    )
    post = await client.send_post(request)
    print(f"Created post: {post.uri}")

    # Get timeline
    from elizaos_plugin_bluesky import TimelineRequest

    timeline = await client.get_timeline(TimelineRequest(limit=10))
    for item in timeline.feed:
        print(f"@{item.post.author.handle}: {item.post.record.text}")
```

## Environment Variables

Required:

- `BLUESKY_HANDLE`: Your BlueSky handle
- `BLUESKY_PASSWORD`: Your app password

Optional:

- `BLUESKY_SERVICE`: BlueSky service URL (default: https://bsky.social)
- `BLUESKY_DRY_RUN`: Enable dry run mode (default: false)
- `BLUESKY_POLL_INTERVAL`: Notification polling interval in seconds (default: 60)
- `BLUESKY_ENABLE_POSTING`: Enable automated posting (default: true)
- `BLUESKY_ENABLE_DMS`: Enable direct messaging (default: true)

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_plugin_bluesky

# Linting
ruff check .
ruff format .
```

## License

MIT



