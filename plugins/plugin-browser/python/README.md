# Browser Automation Plugin for ElizaOS (Python)

Browser automation plugin enabling AI agents to browse websites, interact with elements, and extract data.

## Features

- **Navigation**: Navigate to URLs, go back/forward, refresh pages
- **AI-Powered Interactions**: Click, type, and select elements using natural language
- **Data Extraction**: Extract structured data from web pages
- **Screenshots**: Capture page screenshots
- **CAPTCHA Solving**: Automatic CAPTCHA solving (Turnstile, reCAPTCHA, hCaptcha)
- **Session Management**: Handle multiple browser sessions
- **Security**: URL validation, domain filtering, rate limiting

## Installation

```bash
pip install elizaos-plugin-browser
```

Or with poetry:

```bash
poetry add elizaos-plugin-browser
```

## Configuration

Environment variables:

```bash
# Optional - for cloud browser
BROWSERBASE_API_KEY=your_api_key
BROWSERBASE_PROJECT_ID=your_project_id

# Optional - for AI-powered interactions
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key

# Optional - for CAPTCHA solving
CAPSOLVER_API_KEY=your_capsolver_key

# Browser settings
BROWSER_HEADLESS=true
BROWSER_SERVER_PORT=3456
```

## Usage

```python
import asyncio
from elizaos_browser import BrowserPlugin, create_browser_plugin

async def main():
    # Create and initialize plugin
    plugin = create_browser_plugin()
    await plugin.init()

    try:
        # Navigate to a page
        result = await plugin.handle_action(
            "BROWSER_NAVIGATE",
            "Go to google.com"
        )
        print(f"Navigated: {result}")

        # Click on element
        result = await plugin.handle_action(
            "BROWSER_CLICK",
            "Click on the search button"
        )
        print(f"Clicked: {result}")

        # Type text
        result = await plugin.handle_action(
            "BROWSER_TYPE",
            'Type "hello world" in the search box'
        )
        print(f"Typed: {result}")

        # Extract data
        result = await plugin.handle_action(
            "BROWSER_EXTRACT",
            "Extract the main heading"
        )
        print(f"Extracted: {result}")

        # Take screenshot
        result = await plugin.handle_action(
            "BROWSER_SCREENSHOT",
            "Take a screenshot"
        )
        print(f"Screenshot: {result}")

        # Get browser state
        state = await plugin.get_provider("BROWSER_STATE")
        print(f"State: {state}")

    finally:
        await plugin.stop()

if __name__ == "__main__":
    asyncio.run(main())
```

## Actions

| Action               | Description        | Examples                            |
| -------------------- | ------------------ | ----------------------------------- |
| `BROWSER_NAVIGATE`   | Navigate to URL    | "Go to google.com"                  |
| `BROWSER_BACK`       | Go back in history | "Go back"                           |
| `BROWSER_FORWARD`    | Go forward         | "Go forward"                        |
| `BROWSER_REFRESH`    | Refresh page       | "Refresh the page"                  |
| `BROWSER_CLICK`      | Click element      | "Click the search button"           |
| `BROWSER_TYPE`       | Type text          | "Type 'hello' in the search box"    |
| `BROWSER_SELECT`     | Select option      | "Select 'US' from country dropdown" |
| `BROWSER_EXTRACT`    | Extract data       | "Extract the main heading"          |
| `BROWSER_SCREENSHOT` | Take screenshot    | "Take a screenshot"                 |

## Providers

| Provider        | Description                   |
| --------------- | ----------------------------- |
| `BROWSER_STATE` | Current browser session state |

## API

### BrowserService

```python
class BrowserService:
    async def create_session(self, session_id: str) -> BrowserSession: ...
    async def get_session(self, session_id: str) -> BrowserSession | None: ...
    async def get_current_session(self) -> BrowserSession | None: ...
    async def destroy_session(self, session_id: str) -> None: ...
```

### BrowserSession

```python
@dataclass
class BrowserSession:
    id: str
    created_at: datetime
    url: str | None = None
    title: str | None = None
```

## Development

```bash
# Install dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type check
mypy elizaos_browser

# Lint
ruff check elizaos_browser
```

## License

MIT



