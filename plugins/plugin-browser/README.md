# @elizaos/plugin-browser

Browser automation plugin for Eliza OS that provides web scraping and browser automation capabilities.

## Overview

The Browser plugin serves as a powerful component of Eliza OS, providing browser automation and web scraping capabilities using Playwright. It enables automated web interactions, content extraction, and browser-based tasks for Eliza agents.

## Features

- **Browser Automation**: Web scraping and content extraction with Playwright
- **Multiple Browser Support**: Works with Chromium, Firefox, and WebKit
- **Headless Mode**: Support for both headless and headed browser operations
- **Page Interaction**: Automated form filling, clicking, and navigation
- **Content Extraction**: HTML parsing and data extraction
- **Screenshot Capture**: Page and element screenshot capabilities
- **Network Handling**: Request interception and network monitoring

## Installation

```bash
npm install @elizaos/plugin-browser
```

## Configuration

The plugin may require various environment variables depending on your use case:

### Core Settings

```env
CAPSOLVER_API_KEY=your_capsolver_api_key  # Optional: For CAPTCHA solving capabilities
```

## Usage

```typescript
import { createBrowserPlugin } from "@elizaos/plugin-browser";

// Initialize the plugin
const browserPlugin = createBrowserPlugin();

// Register with Eliza OS
elizaos.registerPlugin(browserPlugin);
```

## Services

### BrowserService

Provides comprehensive web automation and scraping capabilities using Playwright:

- Page navigation and interaction
- Form filling and submission
- Content extraction and parsing
- Screenshot capture
- Network request handling
- CAPTCHA solving (with appropriate configuration)

## Safety & Security

### Browser Operations

- **Sandbox Environment**: Browser operations run in isolated contexts
- **Resource Management**: Automatic cleanup of browser instances
- **Request Filtering**: Control over network requests
- **Memory Management**: Efficient handling of browser resources

## Troubleshooting

### Common Issues

1. **Browser Launch Failures**

```bash
Error: Failed to launch browser
```

- Verify system dependencies are installed
- Check for sufficient system resources
- Ensure proper permissions

2. **Page Navigation Issues**

```bash
Error: Navigation timeout
```

- Check network connectivity
- Verify URL accessibility
- Adjust timeout settings

### Debug Mode

Enable debug logging for detailed troubleshooting:

```typescript
process.env.DEBUG = "eliza:plugin-browser:*";
```

### System Requirements

- Node.js 16.x or higher
- Supported operating system (Windows, macOS, or Linux)
- Sufficient RAM for browser operations
- Internet connectivity

## Support

For issues and feature requests, please:

1. Check the troubleshooting guide above
2. Review existing GitHub issues
3. Submit a new issue with:
    - System information
    - Error logs
    - Steps to reproduce

## Credits

This plugin integrates with and builds upon several key technologies:

- [Playwright](https://playwright.dev/) - Core browser automation
- [CAPSolver](https://capsolver.com/) - CAPTCHA solving capabilities (optional)

Special thanks to:

- The Playwright community for their excellent browser automation framework
- The Eliza community for their contributions and feedback

## License

This plugin is part of the Eliza project. See the main project repository for license information.
