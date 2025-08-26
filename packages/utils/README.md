# @elizaos/utils

Common build utilities for ElizaOS packages.

This package provides standardized build utilities used across the ElizaOS monorepo, including:

- Build configuration helpers
- Asset copying utilities
- TypeScript declaration generation
- File watching and rebuild automation
- Performance timing utilities

## Usage

```typescript
import {
  createBuildRunner,
  createElizaBuildConfig,
  cleanBuild,
  copyAssets,
  generateDts,
  watchFiles,
  getTimer
} from '@elizaos/utils';
```

## API

### `createBuildRunner(options: BuildRunnerOptions)`

Creates a standardized build runner with watch mode support.

### `createElizaBuildConfig(options: ElizaBuildOptions)`

Creates a standardized Bun build configuration for ElizaOS packages.

### `cleanBuild(outdir?: string, maxRetries?: number)`

Cleans build artifacts with proper error handling and retry logic.

### `copyAssets(assets: Array<{ from: string; to: string }>)`

Copies assets after build with proper error handling.

### `generateDts(tsconfigPath?: string, throwOnError?: boolean)`

Generates TypeScript declarations using tsc.

### `watchFiles(directory: string, onChange: () => void, options?: WatchOptions)`

Watches files for changes and triggers rebuilds with proper cleanup.

### `getTimer()`

Returns a performance timer utility.
