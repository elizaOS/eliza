# Configuration

Config is loaded by [c12](https://github.com/unjs/c12) from a `babylon.config.ts` file in the project root (or `.js`, `.json`, `.mjs`, etc.). c12 handles all the file format detection.

## Config file

```ts
// babylon.config.ts
import { defineBabylonConfig } from '@babylon/sim';

export default defineBabylonConfig({
  systemsDir: './systems',
  budgetMs: 60_000,
  disabledSystems: ['expensive-analytics'],
  dev: {
    watch: true,
    watchConfig: true,
  },
});
```

`defineBabylonConfig()` is an identity function that provides type checking. It does not transform anything.

## Options

| Key | Type | Default | Description |
|---|---|---|---|
| `systemsDir` | `string` | `'./systems'` | Directory to scan for system files, relative to project root |
| `budgetMs` | `number` | `60000` | Tick deadline in milliseconds |
| `systemPhases` | `Record<string, TickPhase>` | `undefined` | Override the phase for specific system ids |
| `disabledSystems` | `string[]` | `undefined` | System ids to skip during scanning |
| `dev.watch` | `boolean` | `true` | Watch for system file changes in dev mode |
| `dev.watchConfig` | `boolean` | `true` | Restart on config file changes in dev mode |

The config interface also has `[key: string]: unknown`, so you can add any custom keys and read them later from `ctx.config`.

## Environment variables

c12 is configured with `dotenv: true`. The config loader finds the git repository root and loads `.env` from there, so your env file at the repo root works even when running from a nested package directory. You do not need to install dotenv or call `dotenv.config()`. If the directory is not inside a git repo, it falls back to loading `.env` from the config cwd.

Any environment variable is available in `process.env` inside your config file and inside your systems at runtime.

## Programmatic loading

```ts
import { loadBabylonConfig } from '@babylon/sim';

const { config, configFile } = await loadBabylonConfig('/path/to/project');
console.log(config.budgetMs);
console.log(configFile); // absolute path to the config file, or undefined
```

## Watching for changes

```ts
import { watchBabylonConfig } from '@babylon/sim';

const watcher = await watchBabylonConfig('/path/to/project', (newConfig) => {
  console.log('Config changed:', newConfig);
});

// Later:
await watcher.close();
```

The dev CLI command uses this to restart the engine when the config changes.
