# @elizaos/plugin-dummy-services

Mock/dummy service implementations for testing ElizaOS agents without external API dependencies.

## Overview

This plugin provides dummy implementations of common ElizaOS services, enabling developers to test agent functionality without requiring external API keys, network connections, or third-party services. All services return predictable mock data, making them ideal for unit tests, integration tests, and local development.

## Installation

```bash
bun add @elizaos/plugin-dummy-services
```

## Available Services

| Service | Service Type | Description |
|---------|--------------|-------------|
| `DummyTokenDataService` | `token_data` | Mock token/cryptocurrency data with prices, market caps, and volume |
| `DummyLpService` | `lp` | Mock liquidity pool operations (add/remove liquidity, swaps) |
| `DummyWalletService` | `wallet` | Mock wallet with balance tracking and portfolio management |
| `DummyPdfService` | `pdf` | Mock PDF operations (extract text, generate, merge, split) |
| `DummyVideoService` | `video` | Mock video processing (info, download, extract audio/frames) |
| `DummyBrowserService` | `browser` | Mock browser automation (navigate, screenshot, click, type) |
| `DummyTranscriptionService` | `transcription` | Mock speech-to-text and text-to-speech operations |
| `DummyWebSearchService` | `web_search` | Mock web, news, image, and video search |
| `DummyEmailService` | `email` | Mock email operations (send, search, folders) |

## Usage

### Using the Full Plugin

Import and register the plugin to load all dummy services at once:

```typescript
import { dummyServicesPlugin } from '@elizaos/plugin-dummy-services';

const character = {
  name: 'TestAgent',
  plugins: [dummyServicesPlugin],
  // ... other character config
};
```

### Using Individual Services

Import specific services for targeted testing:

```typescript
import {
  DummyTokenDataService,
  DummyWalletService,
  DummyBrowserService,
} from '@elizaos/plugin-dummy-services';

// Access services via runtime
const tokenService = runtime.getService<DummyTokenDataService>('token_data');
const walletService = runtime.getService<DummyWalletService>('wallet');
const browserService = runtime.getService<DummyBrowserService>('browser');
```

## Service Details

### DummyTokenDataService

Provides mock cryptocurrency/token data:

```typescript
const tokenService = runtime.getService<DummyTokenDataService>('token_data');

// Get token data by address
const token = await tokenService.getTokenData('0x...');
// Returns: { symbol, name, priceUsd, marketCapUsd, volume24hUsd, ... }

// Get token by symbol
const token = await tokenService.getTokenDataBySymbol('ETH');

// Get trending tokens
const trending = await tokenService.getTrendingTokens('solana', 10);

// Search tokens
const results = await tokenService.searchTokens('BTC', 'ethereum', 5);
```

### DummyLpService

Provides mock liquidity pool operations:

```typescript
const lpService = runtime.getService<DummyLpService>('lp');

// Get pool info
const pool = await lpService.getPoolInfo('0xPoolAddress');

// Add liquidity
const result = await lpService.addLiquidity({
  poolAddress: '0x...',
  tokenAMint: '0x...',
  tokenBMint: '0x...',
  tokenAAmountLamports: '1000000000',
  slippageBps: 50,
});

// Remove liquidity
const result = await lpService.removeLiquidity({
  poolAddress: '0x...',
  lpTokenMint: '0x...',
  lpTokenAmountLamports: '100000000',
  slippageBps: 50,
});

// Get available pools
const pools = await lpService.getPools();
```

### DummyWalletService

Provides mock wallet with balance management:

```typescript
const walletService = runtime.getService<DummyWalletService>('wallet');

// Get balance
const balance = await walletService.getBalance('USDC');

// Set portfolio holdings (for test setup)
walletService.setPortfolioHolding('ETH', 10, 2000); // 10 ETH at $2000

// Get full portfolio
const portfolio = walletService.getPortfolio();
// Returns: { totalValueUsd, assets: [{ symbol, balance, valueUsd, allocation }] }

// Reset wallet to initial state
walletService.resetWallet(10000, 'USDC'); // $10,000 USDC
```

### DummyPdfService

Provides mock PDF operations:

```typescript
const pdfService = runtime.getService<DummyPdfService>('pdf');

// Extract text from PDF
const result = await pdfService.extractText(pdfBuffer);
// Returns: { text, metadata: { title, author, pages, creationDate } }

// Generate PDF from content
const pdf = await pdfService.generatePdf('Hello World', { format: 'A4' });

// Merge multiple PDFs
const merged = await pdfService.mergePdfs([pdf1, pdf2, pdf3]);

// Split PDF into parts
const parts = await pdfService.splitPdf(pdfBuffer, [[1, 5], [6, 10]]);
```

### DummyVideoService

Provides mock video processing:

```typescript
const videoService = runtime.getService<DummyVideoService>('video');

// Get video info
const info = await videoService.getVideoInfo('https://example.com/video');
// Returns: { title, duration, resolution, format, size, fps, codec }

// Download video
const buffer = await videoService.downloadVideo(url, { quality: 'highest' });

// Extract audio
const audio = await videoService.extractAudio(videoBuffer);

// Extract frames at specific timestamps
const frames = await videoService.extractFrames(videoBuffer, [0, 5, 10]);

// Get available formats
const formats = await videoService.getAvailableFormats(url);
```

### DummyBrowserService

Provides mock browser automation:

```typescript
const browserService = runtime.getService<DummyBrowserService>('browser');

// Navigate to URL
await browserService.navigate('https://example.com', { waitUntil: 'load' });

// Take screenshot
const screenshot = await browserService.screenshot({ fullPage: true });

// Extract content
const content = await browserService.extractContent([
  { selector: '.main-content', type: 'css' }
]);

// Interact with elements
await browserService.click({ selector: '#submit-btn', type: 'css' });
await browserService.type({ selector: '#email', type: 'css' }, 'test@example.com');

// Navigation history
await browserService.goBack();
await browserService.goForward();
await browserService.refresh();
```

### DummyTranscriptionService

Provides mock speech-to-text and text-to-speech:

```typescript
const transcriptionService = runtime.getService<DummyTranscriptionService>('transcription');

// Transcribe audio
const result = await transcriptionService.transcribeAudio(audioBuffer, {
  language: 'en',
  timestamps: true,
});
// Returns: { text, language, duration, segments, words }

// Speech to text
const text = await transcriptionService.speechToText(audioBuffer);

// Text to speech
const audio = await transcriptionService.textToSpeech('Hello world', {
  voice: 'en-US',
  format: 'mp3',
});

// Detect language
const language = await transcriptionService.detectLanguage(audioBuffer);

// Translate audio
const translated = await transcriptionService.translateAudio(audioBuffer, 'es', 'en');
```

### DummyWebSearchService

Provides mock web search operations:

```typescript
const searchService = runtime.getService<DummyWebSearchService>('web_search');

// Web search
const results = await searchService.search({
  query: 'ElizaOS',
  limit: 10,
});
// Returns: { results: [{ title, url, description, relevanceScore }], totalResults }

// News search
const news = await searchService.searchNews({
  query: 'AI agents',
  sortBy: 'date',
});

// Image search
const images = await searchService.searchImages({
  query: 'robots',
  size: 'large',
});

// Video search
const videos = await searchService.searchVideos({
  query: 'tutorial',
  duration: 'medium',
});

// Autocomplete suggestions
const suggestions = await searchService.autocomplete('eliza');

// Trending searches
const trending = await searchService.getTrendingSearches('US');
```

### DummyEmailService

Provides mock email operations:

```typescript
const emailService = runtime.getService<DummyEmailService>('email');

// Send email
const messageId = await emailService.sendEmail(
  [{ address: 'recipient@example.com', name: 'Recipient' }],
  'Test Subject',
  'Email body content',
  {
    cc: [{ address: 'cc@example.com' }],
    attachments: [{ filename: 'doc.pdf', content: buffer }],
  }
);

// Search emails
const emails = await emailService.searchEmails({
  from: 'sender@example.com',
  subject: 'important',
  limit: 10,
});

// Get specific email
const email = await emailService.getEmail(messageId);

// Folder operations
const folders = await emailService.getFolders();
await emailService.createFolder('Projects');
await emailService.moveToFolder(messageId, 'Projects');

// Reply and forward
await emailService.replyToEmail(messageId, 'Reply body', { replyAll: true });
await emailService.forwardEmail(messageId, [{ address: 'forward@example.com' }]);
```

## When to Use Dummy Services vs Real Services

| Scenario | Recommended |
|----------|-------------|
| Unit tests | Dummy services |
| Integration tests (isolated) | Dummy services |
| E2E tests (full stack) | Real services or configurable |
| Local development without API keys | Dummy services |
| CI/CD pipelines | Dummy services |
| Production | Real services |
| Demo/showcase environments | Dummy services |
| Performance testing | Real services |

## Testing

The plugin includes built-in E2E test scenarios:

```typescript
import { dummyServicesScenariosSuite } from '@elizaos/plugin-dummy-services';

// The test suite is automatically registered with the plugin
// Run tests via: bun test
```

## License

MIT
