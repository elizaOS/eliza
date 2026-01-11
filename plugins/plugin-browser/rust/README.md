# Browser Automation Plugin for ElizaOS (Rust)

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

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-plugin-browser = "1.0"
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

```rust
use elizaos_browser::{BrowserPlugin, create_browser_plugin, BrowserConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create and initialize plugin
    let mut plugin = create_browser_plugin(None);
    plugin.init().await?;

    // Navigate to a page
    let result = plugin
        .handle_action("BROWSER_NAVIGATE", "Go to google.com")
        .await?;
    println!("Navigated: {:?}", result);

    // Click on element
    let result = plugin
        .handle_action("BROWSER_CLICK", "Click on the search button")
        .await?;
    println!("Clicked: {:?}", result);

    // Type text
    let result = plugin
        .handle_action("BROWSER_TYPE", "Type 'hello world' in the search box")
        .await?;
    println!("Typed: {:?}", result);

    // Extract data
    let result = plugin
        .handle_action("BROWSER_EXTRACT", "Extract the main heading")
        .await?;
    println!("Extracted: {:?}", result);

    // Take screenshot
    let result = plugin
        .handle_action("BROWSER_SCREENSHOT", "Take a screenshot")
        .await?;
    println!("Screenshot: {:?}", result);

    // Get browser state
    let state = plugin.get_provider("BROWSER_STATE").await?;
    println!("State: {:?}", state);

    plugin.stop().await;
    Ok(())
}
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

```rust
impl BrowserService {
    pub async fn create_session(&self, session_id: &str) -> Result<BrowserSession, String>;
    pub async fn get_session(&self, session_id: &str) -> Option<BrowserSession>;
    pub async fn get_current_session(&self) -> Option<BrowserSession>;
    pub async fn destroy_session(&self, session_id: &str) -> Result<(), String>;
}
```

### BrowserSession

```rust
pub struct BrowserSession {
    pub id: String,
    pub created_at: DateTime<Utc>,
    pub url: Option<String>,
    pub title: Option<String>,
}
```

## Development

```bash
# Build
cargo build

# Run tests
cargo test

# Check lints
cargo clippy

# Format code
cargo fmt
```

## License

MIT



