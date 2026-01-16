export type RuntimeEnvironment = 'node' | 'browser' | 'unknown';

export interface EnvironmentConfig {
  [key: string]: string | boolean | number | undefined;
}

// Memoized environment detection - computed once at module load
let cachedEnvironment: RuntimeEnvironment | null = null;

export function detectEnvironment(): RuntimeEnvironment {
  if (cachedEnvironment !== null) return cachedEnvironment;

  if (typeof process !== 'undefined' && process.versions?.node) {
    cachedEnvironment = 'node';
    return cachedEnvironment;
  }

  interface GlobalWithWindow {
    window?: Window & { document?: Document };
  }

  const global = globalThis as GlobalWithWindow;
  if (typeof globalThis !== 'undefined' && global.window?.document !== undefined) {
    cachedEnvironment = 'browser';
    return cachedEnvironment;
  }

  cachedEnvironment = 'unknown';
  return cachedEnvironment;
}

/**
 * Resets the cached environment detection result.
 * This is primarily for testing purposes when mocking different environments.
 */
export function resetEnvironmentCache(): void {
  cachedEnvironment = null;
}

class BrowserEnvironmentStore {
  private store: EnvironmentConfig = {};

  constructor() {
    interface GlobalWithWindowEnv {
      window?: { ENV?: EnvironmentConfig };
    }
    interface GlobalWithEnv {
      __ENV__?: EnvironmentConfig;
    }

    const windowWithEnv = globalThis as GlobalWithWindowEnv;
    if (windowWithEnv.window?.ENV) {
      this.store = { ...windowWithEnv.window.ENV };
    }

    const globalWithEnv = globalThis as GlobalWithEnv;
    if (globalWithEnv.__ENV__) {
      this.store = { ...this.store, ...globalWithEnv.__ENV__ };
    }
  }

  get(key: string): string | undefined {
    const value = this.store[key];
    return value !== undefined ? String(value) : undefined;
  }

  set(key: string, value: string | boolean | number): void {
    this.store[key] = value;
  }

  getAll(): EnvironmentConfig {
    return { ...this.store };
  }
}

class Environment {
  private runtime: RuntimeEnvironment;
  private browserStore?: BrowserEnvironmentStore;
  private cache = new Map<string, string | undefined>();

  constructor() {
    this.runtime = detectEnvironment();
    if (this.runtime === 'browser') {
      this.browserStore = new BrowserEnvironmentStore();
    }
  }

  getRuntime(): RuntimeEnvironment {
    return this.runtime;
  }

  isNode(): boolean {
    return this.runtime === 'node';
  }

  isBrowser(): boolean {
    return this.runtime === 'browser';
  }

  get(key: string, defaultValue?: string): string | undefined {
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      return cached ?? defaultValue;
    }

    let value: string | undefined;
    if (this.runtime === 'node' && typeof process !== 'undefined') {
      value = process.env[key];
    } else if (this.runtime === 'browser') {
      value = this.browserStore?.get(key);
    }

    this.cache.set(key, value);
    return value ?? defaultValue;
  }

  set(key: string, value: string | boolean | number): void {
    this.cache.delete(key);
    const stringValue = String(value);

    if (this.runtime === 'node' && typeof process !== 'undefined') {
      process.env[key] = stringValue;
    } else if (this.runtime === 'browser') {
      this.browserStore?.set(key, value);
    }
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  getAll(): EnvironmentConfig {
    if (this.runtime === 'node' && typeof process !== 'undefined') {
      return { ...process.env };
    }
    if (this.runtime === 'browser' && this.browserStore) {
      return this.browserStore.getAll();
    }
    return {};
  }

  // Pre-computed Set for truthy value checks - avoids array allocation on each call
  private static readonly TRUTHY_VALUES = new Set(['true', '1', 'yes', 'on']);

  getBoolean(key: string, defaultValue = false): boolean {
    const value = this.get(key);
    if (value === undefined) return defaultValue;
    return Environment.TRUTHY_VALUES.has(value.toLowerCase());
  }

  getNumber(key: string, defaultValue?: number): number | undefined {
    const value = this.get(key);
    if (value === undefined) return defaultValue;
    const parsed = Number(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

let environmentInstance: Environment | null = null;

export function getEnvironment(): Environment {
  environmentInstance ??= new Environment();
  return environmentInstance;
}

export function getEnv(key: string, defaultValue?: string): string | undefined {
  return getEnvironment().get(key, defaultValue);
}

export function setEnv(key: string, value: string | boolean | number): void {
  getEnvironment().set(key, value);
}

export function hasEnv(key: string): boolean {
  return getEnvironment().has(key);
}

export function getBooleanEnv(key: string, defaultValue = false): boolean {
  return getEnvironment().getBoolean(key, defaultValue);
}

export function getNumberEnv(key: string, defaultValue?: number): number | undefined {
  return getEnvironment().getNumber(key, defaultValue);
}

export function initBrowserEnvironment(config: EnvironmentConfig): void {
  const env = getEnvironment();
  if (env.isBrowser()) {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) env.set(key, value);
    }
  }
}

export const currentRuntime = detectEnvironment();

export { Environment };

export function findEnvFile(
  startDir?: string,
  filenames: string[] = ['.env', '.env.local']
): string | null {
  if (typeof process === 'undefined' || !process.cwd) return null;

  const fs = require('node:fs');
  const nodePath = require('node:path');

  let currentDir = startDir || process.cwd();

  while (true) {
    for (const filename of filenames) {
      const candidate = nodePath.join(currentDir, filename);
      if (fs.existsSync(candidate)) return candidate;
    }

    const parentDir = nodePath.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return null;
}

export interface LoadEnvOptions {
  override?: boolean;
}

export function loadEnvFile(envPath?: string, options?: LoadEnvOptions): boolean {
  if (typeof process === 'undefined' || !process.cwd) return false;

  const dotenv = require('dotenv');
  const resolvedPath = envPath || findEnvFile();
  if (!resolvedPath) return false;

  const result = dotenv.config({ path: resolvedPath, override: options?.override ?? false });
  if (result.error) {
    console?.warn?.(`Failed to parse .env file at ${resolvedPath}:`, result.error);
    return false;
  }
  return true;
}

export function findAllEnvFiles(startDir: string, boundaryDir?: string): string[] {
  if (typeof process === 'undefined' || !process.cwd) return [];

  const nodePath = require('path');
  const fs = require('fs');
  const envFiles: string[] = [];

  // Resolve boundary dir once outside the loop instead of each iteration
  const resolvedBoundary = boundaryDir ? nodePath.resolve(boundaryDir) : null;

  let currentDir = startDir;
  for (let i = 0; i < 10; i++) {
    const envPath = nodePath.join(currentDir, '.env');
    if (fs.existsSync(envPath)) envFiles.push(envPath);

    if (resolvedBoundary && nodePath.resolve(currentDir) === resolvedBoundary) break;

    const parentDir = nodePath.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return envFiles;
}

/**
 * Loads .env files with proper precedence (closest file wins).
 */
export function loadEnvFilesWithPrecedence(
  startDir: string,
  options?: { boundaryDir?: string; clearBeforeLoad?: boolean; varsToClear?: string[] }
): string[] {
  const envFiles = findAllEnvFiles(startDir, options?.boundaryDir);
  if (envFiles.length === 0) return [];

  if (options?.clearBeforeLoad && options.varsToClear) {
    for (const varName of options.varsToClear) {
      delete process.env[varName];
    }
  }

  // Iterate backwards instead of creating a reversed copy with [...envFiles].reverse()
  for (let i = envFiles.length - 1; i >= 0; i--) {
    loadEnvFile(envFiles[i], { override: true });
  }

  return envFiles;
}
