# Browser Plugin Protocol

This directory contains the shared protocol definitions for the browser automation plugin across all supported languages (TypeScript, Python, and Rust).

## Overview

The browser plugin provides AI-powered browser automation capabilities through a unified protocol. All language implementations must adhere to this protocol for interoperability.

## Schema

The `schema.json` file defines:

### Data Types
- **SessionId**: Unique identifier format for browser sessions
- **BrowserSession**: Session object with ID, timestamps, and page info
- **NavigationResult**: Result of navigation operations
- **ActionResult**: Result of browser actions (click, type, select)
- **ExtractResult**: Result of data extraction operations
- **ScreenshotResult**: Screenshot data with metadata
- **CaptchaResult**: CAPTCHA detection and solving results

### Configuration
- **SecurityConfig**: URL validation and domain filtering settings
- **RetryConfig**: Retry behavior with exponential backoff
- **BrowserConfig**: Browser and service configuration

### Communication
- **WebSocketMessage**: Client-to-server message format
- **WebSocketResponse**: Server-to-client response format
- **BrowserError**: Standardized error format

## Actions

All implementations must support these actions:

| Action | Description |
|--------|-------------|
| `BROWSER_NAVIGATE` | Navigate to a URL |
| `BROWSER_BACK` | Go back in history |
| `BROWSER_FORWARD` | Go forward in history |
| `BROWSER_REFRESH` | Refresh current page |
| `BROWSER_CLICK` | Click on element |
| `BROWSER_TYPE` | Type text into field |
| `BROWSER_SELECT` | Select dropdown option |
| `BROWSER_EXTRACT` | Extract page data |
| `BROWSER_SCREENSHOT` | Capture screenshot |
| `BROWSER_SOLVE_CAPTCHA` | Solve CAPTCHA |

## Providers

| Provider | Description |
|----------|-------------|
| `BROWSER_STATE` | Current browser session state |

## Error Codes

| Code | Description |
|------|-------------|
| `SERVICE_NOT_AVAILABLE` | Browser service not running |
| `SESSION_ERROR` | Session management error |
| `NAVIGATION_ERROR` | Page navigation failed |
| `ACTION_ERROR` | Browser action failed |
| `SECURITY_ERROR` | Security validation failed |
| `CAPTCHA_ERROR` | CAPTCHA solving failed |
| `TIMEOUT_ERROR` | Operation timed out |

## Implementation Requirements

Each language implementation must:

1. Support all defined actions and providers
2. Use the WebSocket protocol for server communication
3. Implement security validation for URLs
4. Support retry with exponential backoff
5. Handle CAPTCHA detection (solving optional based on API key)
6. Emit appropriate events for action tracking
7. Provide proper error handling with user-friendly messages


