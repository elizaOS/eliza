# Browser Extension Test Harness

This directory contains tools for testing the ComputerUse Bridge Extension.

## Overview

The ComputerUse Bridge Extension is a Chrome MV3 extension that enables JavaScript
evaluation in browser tabs via a WebSocket connection. This test harness validates
that the extension correctly:

1. Connects to the WebSocket server at `ws://127.0.0.1:17373`
2. Receives eval requests with the correct protocol
3. Evaluates JavaScript in the active tab
4. Returns results (or errors) with the correct format

## Prerequisites

1. **Chrome/Chromium browser** with Developer Mode enabled
2. **The extension loaded** from `eliza/packages/computeruse/crates/computeruse/browser-extension/`
3. **At least one browser tab** open (extension needs a tab to evaluate code in)
4. **Node.js 22+** with tsx installed

## Loading the Extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `browser-extension/` directory
5. Verify the extension appears and is enabled

## Running the Test Harness

### Basic Test Run

```bash
# From milady root
npx tsx test/browser-extension/test-harness.ts
```

### Options

```bash
# Verbose output (show all messages)
npx tsx test/browser-extension/test-harness.ts --verbose

# Interactive mode (keep server running for manual testing)
npx tsx test/browser-extension/test-harness.ts --interactive

# Custom port (default: 17373)
npx tsx test/browser-extension/test-harness.ts --port 17374

# Custom timeout (default: 30000ms)
npx tsx test/browser-extension/test-harness.ts --timeout 60000
```

## Protocol Specification

### Request Format

```json
{
  "id": "unique-request-id",
  "action": "eval",
  "code": "document.title",
  "awaitPromise": false
}
```

### Success Response

```json
{
  "id": "unique-request-id",
  "ok": true,
  "result": "Page Title"
}
```

### Error Response

```json
{
  "id": "unique-request-id",
  "ok": false,
  "error": "ReferenceError: foo is not defined"
}
```

## Test Categories

The harness runs tests in these categories:

1. **Basic JavaScript Evaluation** - Simple expressions, arrays, objects
2. **DOM Access** - document.title, location.href, querySelectorAll
3. **Promise Handling** - awaitPromise flag, async operations
4. **Error Handling** - Syntax errors, runtime errors, rejected promises
5. **Complex Operations** - Page metadata extraction, finding elements

## Troubleshooting

### Extension doesn't connect

1. Check that the extension is loaded and enabled in `chrome://extensions`
2. Check that Developer mode is enabled
3. Reload the extension by clicking the refresh button
4. Make sure at least one tab is open (not just chrome:// pages)

### Tests timeout

1. The extension may need a moment to connect after loading
2. Try increasing the timeout: `--timeout 60000`
3. Check Chrome DevTools for extension errors (go to `chrome://extensions`, click "Inspect views" on the extension)

### "Cannot evaluate in this tab"

Some pages block extension access:
- `chrome://` pages
- `edge://` pages
- Extension pages
- Some protected sites

Navigate to a regular webpage (like https://example.com) before running tests.

## Manual Testing

For manual testing, start the harness in interactive mode:

```bash
npx tsx test/browser-extension/test-harness.ts --interactive --verbose
```

Then send requests manually using a tool like `wscat`:

```bash
wscat -c ws://127.0.0.1:17373
> {"id":"1","action":"eval","code":"document.title"}
< {"id":"1","ok":true,"result":"Page Title"}
```
