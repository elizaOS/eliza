import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModuleLoader, getModuleLoader, loadModule, loadModuleSync } from './module-loader';
import path from 'node:path';

describe('ModuleLoader', () => {
  let loader: ModuleLoader;

  beforeEach(() => {
    // Clear any cached instances
    (global as any).defaultLoader = null;
    loader = new ModuleLoader();
  });

  describe('loadSync', () => {
    it('should load a module synchronously', () => {
      // Test loading a core Node.js module
      const pathModule = loader.loadSync('path');
      expect(pathModule).toBeDefined();
      expect(pathModule.join).toBeDefined();
      expect(typeof pathModule.join).toBe('function');
    });

    it('should cache modules for repeated calls', () => {
      // First load
      const firstLoad = loader.loadSync('path');

      // Second load should return the same instance
      const secondLoad = loader.loadSync('path');

      expect(firstLoad).toBe(secondLoad);
    });

    it('should maintain separate caches for sync and async loads', async () => {
      // Load synchronously first
      const syncLoad = loader.loadSync('path');

      // Then load asynchronously
      const asyncLoad = await loader.load('path');

      // They should NOT be the same instance due to separate caches
      // This prevents ESM/CJS conflicts
      expect(syncLoad).not.toBe(asyncLoad);
    });

    it('should throw meaningful error for non-existent modules', () => {
      expect(() => {
        loader.loadSync('non-existent-module-12345');
      }).toThrowError(/Cannot find module 'non-existent-module-12345'/);
    });
  });

  describe('convenience functions', () => {
    it('loadModuleSync should work correctly', () => {
      const pathModule = loadModuleSync('path');
      expect(pathModule).toBeDefined();
      expect(pathModule.join).toBeDefined();
    });

    it('should maintain separate caches for sync and async loads', async () => {
      // Load using convenience functions
      const syncLoad = loadModuleSync('path');
      const asyncLoad = await loadModule('path');

      // They should NOT be the same instance due to separate caches
      expect(syncLoad).not.toBe(asyncLoad);
    });
  });

  describe('singleton behavior', () => {
    it('getModuleLoader should return the same instance', () => {
      const loader1 = getModuleLoader();
      const loader2 = getModuleLoader();

      expect(loader1).toBe(loader2);
    });

    it('modules loaded through singleton should be cached', () => {
      const load1 = loadModuleSync('path');
      const load2 = loadModuleSync('path');

      expect(load1).toBe(load2);
    });
  });
});
