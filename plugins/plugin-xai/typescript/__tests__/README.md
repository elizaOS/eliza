# X Plugin Tests

This directory contains comprehensive unit tests and end-to-end tests for the refactored X plugin.

## Test Structure

```
__tests__/
├── unit/
│   ├── MessageService.test.ts    # Unit tests for XMessageService
│   ├── PostService.test.ts       # Unit tests for XPostService
│   ├── auth.test.ts             # Unit tests for XAuth
│   └── environment.test.ts      # Unit tests for config validation
└── e2e/
    └── x-integration.test.ts # End-to-end tests with real API
```

## Running Tests

### Unit Tests

Unit tests can be run without any X API credentials:

```bash
# Run all unit tests
npm test

# Run specific test file
npm test MessageService.test.ts

# Run with coverage
npm test -- --coverage
```

### End-to-End Tests

E2E tests require real X Developer API credentials and currently exercise **TWITTER_AUTH_MODE=env** (OAuth 1.0a keys/tokens).
The plugin also supports **TWITTER_AUTH_MODE=oauth** (OAuth 2.0 PKCE “login + approve”), but that flow is interactive and is not covered by these E2E tests.

#### Prerequisites

1. **X Developer Account**: You need a X Developer account with an app created
2. **API Credentials (env mode)**: You need all four credentials:
   - API Key (Consumer Key)
   - API Secret Key (Consumer Secret)
   - Access Token
   - Access Token Secret

#### Setup

1. Create a `.env.test` file in the plugin root directory:

```env
# X API v2 Credentials
TWITTER_AUTH_MODE=env
TWITTER_API_KEY=your_api_key_here
TWITTER_API_SECRET_KEY=your_api_secret_key_here
TWITTER_ACCESS_TOKEN=your_access_token_here
TWITTER_ACCESS_TOKEN_SECRET=your_access_token_secret_here
```

2. **Important**: Add `.env.test` to your `.gitignore` to avoid committing credentials

#### Running E2E Tests

```bash
# Run E2E tests (will skip if no credentials)
npm test e2e

# Run with verbose output
npm test e2e -- --reporter=verbose
```

## Test Coverage

### Unit Tests Cover:

1. **MessageService**
   - Fetching messages/mentions
   - Sending messages (posts and DMs)
   - Deleting messages
   - Getting specific messages
   - Marking messages as read

2. **PostService**
   - Creating posts (with replies)
   - Deleting posts
   - Fetching posts
   - Liking/unliking posts
   - Reposting
   - Getting mentions

3. **Authentication**
   - API v2 client initialization
   - Login status verification
   - Profile fetching
   - Logout functionality

4. **Environment Configuration**
   - Config validation
   - Target user filtering
   - Environment variable parsing
   - Priority handling (config > runtime > env)

### E2E Tests Cover:

1. **Authentication**
   - Real API authentication
   - Profile retrieval

2. **Post Operations**
   - Creating posts
   - Creating replies
   - Fetching posts
   - Deleting posts
   - Liking posts

3. **Message Operations**
   - Fetching mentions
   - Sending posts
   - Retrieving specific messages

4. **Search and Timeline**
   - Searching posts
   - Fetching home timeline

5. **Error Handling**
   - Non-existent content
   - Rate limiting (commented out)

## Important Notes

### Test Cleanup

E2E tests automatically clean up created posts after all tests complete. However, if tests are interrupted:

1. Check your X account for test posts (they contain "E2E Test" in the text)
2. Manually delete any remaining test posts

### Rate Limiting

- E2E tests include delays between operations to avoid rate limiting
- The rate limit test is commented out by default
- Be cautious when running E2E tests repeatedly

### Test Data

- All test posts are prefixed with "E2E Test" and include timestamps
- Test posts mention they are automated tests and will be deleted
- The cleanup process tracks all created post IDs

### Mocking

Unit tests use Vitest's mocking capabilities to:

- Mock the X API client
- Mock core dependencies
- Isolate service logic

## Debugging Tests

```bash
# Run tests in watch mode
npm test -- --watch

# Run with detailed error output
npm test -- --reporter=verbose

# Run specific test by name
npm test -- -t "should create a simple post"
```

## CI/CD Considerations

For CI/CD pipelines:

1. **Unit tests** should always run
2. **E2E tests** should only run if credentials are available
3. Consider using GitHub Secrets or similar for API credentials
4. E2E tests might be run on a schedule rather than every commit

Example GitHub Actions setup:

```yaml
- name: Run Unit Tests
  run: npm test unit

- name: Run E2E Tests
  if: ${{ secrets.TWITTER_API_KEY != '' }}
  env:
    TWITTER_API_KEY: ${{ secrets.TWITTER_API_KEY }}
    TWITTER_API_SECRET_KEY: ${{ secrets.TWITTER_API_SECRET_KEY }}
    TWITTER_ACCESS_TOKEN: ${{ secrets.TWITTER_ACCESS_TOKEN }}
    TWITTER_ACCESS_TOKEN_SECRET: ${{ secrets.TWITTER_ACCESS_TOKEN_SECRET }}
  run: npm test e2e
```
