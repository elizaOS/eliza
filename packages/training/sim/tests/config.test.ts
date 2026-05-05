import { describe, expect, it } from 'bun:test';
import {
  defaultConfig,
  defineBabylonConfig,
  loadBabylonConfig,
} from '../core/config';

describe('defineBabylonConfig', () => {
  it('returns the config object unchanged', () => {
    const input = { systemsDir: './custom', budgetMs: 30_000 };
    const result = defineBabylonConfig(input);
    expect(result).toBe(input);
  });
});

describe('defaultConfig', () => {
  it('has sensible defaults', () => {
    expect(defaultConfig.systemsDir).toBe('./systems');
    expect(defaultConfig.budgetMs).toBe(60_000);
    expect(defaultConfig.dev?.watch).toBe(true);
    expect(defaultConfig.dev?.watchConfig).toBe(true);
  });
});

describe('loadBabylonConfig', () => {
  it('returns config with defaults applied', async () => {
    const { config } = await loadBabylonConfig();
    expect(config.systemsDir).toBe('./systems');
    expect(config.budgetMs).toBe(60_000);
  });

  it('accepts a cwd parameter', async () => {
    const { config } = await loadBabylonConfig('/tmp');
    expect(config).toBeDefined();
    expect(config.systemsDir).toBe('./systems');
  });
});
