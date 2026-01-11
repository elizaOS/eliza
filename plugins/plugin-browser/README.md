# Browser Automation Plugin for ElizaOS

Multi-language browser automation plugin enabling AI agents to browse websites, interact with elements, and extract data. Available in **TypeScript**, **Python**, and **Rust** with full feature parity.

## Architecture

```
plugin-browser/
├── protocol/           # Shared protocol definitions (JSON Schema)
├── typescript/         # TypeScript/Node.js implementation
├── python/            # Python implementation
├── rust/              # Rust implementation
└── README.md          # This file
```

## Features

All implementations support:

- **Navigation**: Navigate to URLs, go back/forward, refresh pages
- **AI-Powered Interactions**: Click, type, and select elements using natural language
- **Data Extraction**: Extract structured data from web pages
- **Screenshots**: Capture page screenshots
- **CAPTCHA Solving**: Automatic CAPTCHA solving (Turnstile, reCAPTCHA, hCaptcha)
- **Session Management**: Handle multiple browser sessions
- **Security**: URL validation, domain filtering, rate limiting
- **Retry Logic**: Exponential backoff for reliability

## Implementations

### TypeScript

```bash
cd typescript
npm install
npm run build
```

```typescript
import { browserPlugin } from "@elizaos/plugin-browser";

const agent = {
  plugins: [browserPlugin],
};
```

### Python

```bash
cd python
pip install -e .
```

```python
from elizaos_browser import create_browser_plugin

plugin = create_browser_plugin()
await plugin.init()
await plugin.handle_action("BROWSER_NAVIGATE", "Go to google.com")
```

### Rust

```bash
cd rust
cargo build
```

```rust
use elizaos_browser::create_browser_plugin;

let mut plugin = create_browser_plugin(None);
plugin.init().await?;
plugin.handle_action("BROWSER_NAVIGATE", "Go to google.com").await?;
```

## Actions

All implementations support these actions:

| Action                  | Description            | Example                                 |
| ----------------------- | ---------------------- | --------------------------------------- |
| `BROWSER_NAVIGATE`      | Navigate to a URL      | "Go to google.com"                      |
| `BROWSER_BACK`          | Go back in history     | "Go back"                               |
| `BROWSER_FORWARD`       | Go forward in history  | "Go forward"                            |
| `BROWSER_REFRESH`       | Refresh the page       | "Refresh the page"                      |
| `BROWSER_CLICK`         | Click on an element    | "Click the search button"               |
| `BROWSER_TYPE`          | Type text into a field | "Type 'hello' in the search box"        |
| `BROWSER_SELECT`        | Select dropdown option | "Select 'US' from the country dropdown" |
| `BROWSER_EXTRACT`       | Extract data from page | "Extract the main heading"              |
| `BROWSER_SCREENSHOT`    | Take a screenshot      | "Take a screenshot"                     |
| `BROWSER_SOLVE_CAPTCHA` | Solve CAPTCHA          | "Solve the captcha"                     |

## Providers

| Provider        | Description                                              |
| --------------- | -------------------------------------------------------- |
| `BROWSER_STATE` | Current browser session state (URL, title, session info) |

## Configuration

All implementations use the same environment variables:

```bash
# Browser settings
BROWSER_HEADLESS=true
BROWSER_ENABLED=true
BROWSER_SERVER_PORT=3456

# Cloud browser (optional)
BROWSERBASE_API_KEY=your_api_key
BROWSERBASE_PROJECT_ID=your_project_id

# AI providers for intelligent interactions (optional)
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2-vision

# CAPTCHA solving (optional)
CAPSOLVER_API_KEY=your_capsolver_key
```

## Protocol

The `protocol/` directory contains:

- `schema.json`: JSON Schema defining all types, actions, and messages
- `README.md`: Protocol documentation

All implementations communicate with the browser server using WebSocket and follow the same message protocol, ensuring interoperability.

## Error Handling

All implementations use consistent error codes:

| Code                    | Description                 |
| ----------------------- | --------------------------- |
| `SERVICE_NOT_AVAILABLE` | Browser service not running |
| `SESSION_ERROR`         | Session management error    |
| `NAVIGATION_ERROR`      | Page navigation failed      |
| `ACTION_ERROR`          | Browser action failed       |
| `SECURITY_ERROR`        | Security validation failed  |
| `CAPTCHA_ERROR`         | CAPTCHA solving failed      |
| `TIMEOUT_ERROR`         | Operation timed out         |

## Security

- URL validation with domain allowlists/blocklists
- Input sanitization to prevent XSS/injection
- Rate limiting for actions and sessions
- Protocol restrictions (HTTP/HTTPS only by default)

## Development

### TypeScript

```bash
cd typescript
npm install
npm run build
npm test
npm run typecheck
```

### Python

```bash
cd python
pip install -e ".[dev]"
pytest
mypy elizaos_browser
ruff check elizaos_browser
```

### Rust

```bash
cd rust
cargo build
cargo test
cargo clippy
cargo fmt
```

## License

MIT

## Credits

Built with:

- [Stagehand](https://github.com/browserbase/stagehand) - AI-first browser automation framework
- [Playwright](https://playwright.dev/) - Cross-browser automation
- [CapSolver](https://capsolver.com/) - CAPTCHA solving service
