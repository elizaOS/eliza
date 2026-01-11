# Browser Automation Plugin for ElizaOS (TypeScript)

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
npm install @elizaos/plugin-browser
```

## Configuration

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
BROWSER_ENABLED=true
```

## Usage

```typescript
import { browserPlugin } from '@elizaos/plugin-browser';

const agent = {
  name: 'BrowserAgent',
  plugins: [browserPlugin],
};
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

```typescript
class BrowserService extends Service {
  async createSession(sessionId: string): Promise<BrowserSession>;
  async getSession(sessionId: string): Promise<BrowserSession | undefined>;
  async getCurrentSession(): Promise<BrowserSession | undefined>;
  async destroySession(sessionId: string): Promise<void>;
}
```

### BrowserSession

```typescript
interface BrowserSession {
  id: string;
  createdAt: Date;
  url?: string;
  title?: string;
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type check
npm run typecheck
```

## License

MIT



