# ElizaOS UI Testing Suite

This directory contains comprehensive automated UI tests for the ElizaOS application using Playwright. These tests ensure that the UI functionality works correctly across different browsers and environments.

## Overview

The testing suite validates core UI functionality including:

- Basic web interface access and initialization
- Conversation interactions with agents
- Character configuration and settings management
- Character information viewing
- Settings modification and persistence

## Getting Started

### Prerequisites

- Node.js 16+
- npm or bun

### Installation

The UI tests require Playwright and browser binaries to be installed, which are **not automatically installed** when setting up the repository. Follow these steps for a fresh installation:

```bash
# Navigate to the UI tests directory
cd eliza/packages/client/ui-tests

# Install test dependencies
npm install

# IMPORTANT: Install required browsers (Chromium, Firefox, WebKit)
# This step is mandatory for first-time setup
npm run install:browsers
```

> **Note**: Without running `npm run install:browsers`, the tests will fail as the required browser binaries won't be available. This step downloads approximately 1GB of browser binaries and is only needed once.

## Running Tests

### Quick Start

```bash
# Run all tests with the ElizaOS UI automatically started
npm test

# Run tests with browser visible
npm run test:headed

# Run tests with Playwright UI mode for easier debugging
npm run test:ui
```

### Advanced Options

```bash
# Run a specific test file
npx playwright test tests/05-modify-character-settings.spec.ts

# Run tests in a specific browser
npx playwright test --project=chromium

# Run tests with verbose logging
npx playwright test --debug

# Run tests and keep the browser open after tests finish
npx playwright test --headed --timeout 0
```

## Test Architecture

### File Structure

- `playwright.config.ts`: Configuration for Playwright, including browser settings
- `tests/*.spec.ts`: Individual test files, numbered in dependency order
- `tests/utils.ts`: Shared utility functions for common operations
- `package.json`: Dependencies and scripts for running tests

### Test Files

Each test file is structured to be standalone but follows this naming convention:

1. `01-web-interface-access.spec.ts` - Basic access and initialization
2. `02-basic-conversation.spec.ts` - Message sending/receiving functionality
3. `03-character-configuration.spec.ts` - Character settings panel access
4. `04-view-character-info.spec.ts` - Character info panel functionality
5. `05-modify-character-settings.spec.ts` - Updating and saving character settings

## Test Details

### 01 - Web Interface Access

- Verifies that the ElizaOS web interface loads
- Confirms basic UI elements are present
- Validates initialization completes successfully

### 02 - Basic Conversation

- Accesses the agent chat interface
- Sends test messages to an agent
- Verifies responses are received
- Checks message formatting and display

### 03 - Character Configuration

- Opens the character configuration panel
- Verifies configuration fields are present
- Validates configuration panel UI elements
- Tests navigation between configuration tabs

### 04 - View Character Info

- Opens the character info panel
- Verifies character details are displayed
- Validates presence of key information sections
- Ensures images and formatted content displays correctly

### 05 - Modify Character Settings

- Opens the character settings panel
- Modifies the character username field
- Saves the changes using the save button
- Verifies the success notification appears
- Confirms changes are persisted

## Implementation Details

### Selector Strategy

Tests use a multi-layered approach to element selection:

1. Exact selectors when elements have stable identifiers
2. Attribute-based selectors for consistent UI components
3. Text-based selectors for readable elements
4. Position-based identification for graphical elements
5. Fallback mechanisms when standard selectors fail

### Resilience Features

- **Progressive Enhancement**: Tests adapt to different UI variations
- **Visual Verification**: Screenshots taken at key points for debugging
- **Diagnostic Logging**: Detailed console output for troubleshooting
- **Multiple Selector Approaches**: Alternative selection methods when primary selectors fail
- **Timeout Management**: Configurable timeouts for different operations

## Recent Improvements

### Enhanced Test Stability

- Implemented spatial analysis for locating elements based on position
- Added content change detection to verify UI state transitions
- Improved error handling with detailed diagnostics and recovery strategies
- Enhanced timing adjustments to accommodate varying response times

### Selector Upgrades

- Added support for exact CSS selectors from browser devtools
- Implemented fallback mechanisms for dynamic component styling
- Enhanced element detection with combined attribute and content matching
- Added context-sensitive navigation based on UI state

### Error Recovery

- Added diagnostic screenshots at failure points
- Implemented contextual error messages with detailed state information
- Added graceful fallbacks for unexpected UI states
- Enhanced retry mechanisms for flaky operations

## Running Tests with UI Server

The default configuration starts the ElizaOS UI automatically as part of the test run. This is handled by the `webServer` configuration in `playwright.config.ts`:

```typescript
webServer: {
  command: 'cd ../../.. && bun start',
  url: 'http://localhost:3000',
  reuseExistingServer: !process.env.CI,
  timeout: 60000, // ElizaOS might take some time to start
},
```

If you prefer to run the UI server separately:

1. Start the UI server in one terminal:

   ```bash
   cd eliza
   bun start
   ```

2. Run tests in another terminal:
   ```bash
   cd eliza/packages/client/ui-tests
   PLAYWRIGHT_TEST_BASE_URL=http://localhost:3000 npm test
   ```

## Troubleshooting

### Common Issues

1. **Tests fail to find elements**

   - Check if UI structure has changed
   - Review screenshots in the `screenshots` directory
   - Use `--headed` mode to observe the test in real-time

2. **Timeout errors**

   - Increase timeout settings in the test or config
   - Check if the UI server started correctly
   - Verify network connectivity to the UI server

3. **Inconsistent results**

   - Run with `--debug` flag for more detailed logs
   - Check for race conditions in UI interactions
   - Verify test isolation (tests affecting each other)

4. **Browser compatibility issues**

   - Try running on a different browser project
   - Check browser-specific CSS or JavaScript issues
   - Update Playwright to the latest version

5. **Browser launch failures**
   - Ensure browsers are installed with `npm run install:browsers`
   - Check for missing dependencies on Linux systems (run `npx playwright install-deps`)
   - On headless systems, install xvfb: `apt-get install xvfb` and run with `xvfb-run npx playwright test`
   - For permission issues, try running with sudo: `sudo npx playwright install`

### Debugging Strategies

1. **Interactive debugging**:

   ```bash
   npx playwright test --debug
   ```

2. **UI Mode for test inspection**:

   ```bash
   npx playwright test --ui
   ```

3. **Visual comparison**:

   - Review screenshots in the `screenshots` directory
   - Compare against expected UI states

4. **Trace viewing**:
   ```bash
   npx playwright show-trace test-results/trace.zip
   ```

## Extending the Test Suite

### Creating New Tests

1. Create a new numbered test file in the `tests` directory
2. Import the necessary utilities from `utils.ts`
3. Structure your test following the existing patterns
4. Add meaningful assertions and screenshots

### Best Practices

1. **Keep tests independent**: Each test should run independently
2. **Use utility functions**: Leverage the helper functions in `utils.ts`
3. **Take screenshots**: Capture UI state at key points for debugging
4. **Implement fallbacks**: Always have alternative strategies for element selection
5. **Add detailed logging**: Include console logs to help troubleshooting
6. **Test edge cases**: Cover not just happy paths but error conditions
7. **Validate state changes**: Verify that actions result in expected UI updates

## Continuous Integration

Tests can be run in CI environments with:

```bash
# CI-friendly command
npm run test:ci
```

The CI configuration:

- Runs tests on headless browsers
- Generates reports and artifacts for review
- Includes retries for flaky tests
- Captures screenshots and videos on failure

## References

- [Playwright Documentation](https://playwright.dev/docs/intro)
- [ElizaOS API Documentation](https://docs.elizaos.com)
- [UI Component Library](https://ui.elizaos.com)
