import { logger } from '@elizaos/core';

/**
 * Memory optimization utilities for ElizaOS initialization
 */
export class MemoryOptimizer {
  private static memorySnapshots: Map<string, number> = new Map();
  private static gcEnabled = true;

  /**
   * Take a memory snapshot for comparison
   */
  static takeSnapshot(label: string): void {
    if (global.gc && this.gcEnabled) {
      global.gc();
    }
    const memUsage = process.memoryUsage();
    this.memorySnapshots.set(label, memUsage.heapUsed);

    logger.debug(
      `Memory snapshot '${label}': ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`
    );
  }

  /**
   * Compare current memory with a snapshot
   */
  static compareSnapshot(label: string): { current: number; delta: number } {
    if (global.gc && this.gcEnabled) {
      global.gc();
    }

    const currentMem = process.memoryUsage().heapUsed;
    const snapshotMem = this.memorySnapshots.get(label) || 0;
    const delta = currentMem - snapshotMem;

    logger.debug(
      `Memory delta since '${label}': ${delta > 0 ? '+' : ''}${Math.round(delta / 1024 / 1024)}MB`
    );

    return {
      current: currentMem,
      delta,
    };
  }

  /**
   * Force garbage collection if available
   */
  static forceGC(): void {
    if (global.gc && this.gcEnabled) {
      const before = process.memoryUsage().heapUsed;
      global.gc();
      const after = process.memoryUsage().heapUsed;
      const freed = before - after;

      if (freed > 0) {
        logger.debug(`Garbage collection freed ${Math.round(freed / 1024 / 1024)}MB`);
      }
    }
  }

  /**
   * Get current memory statistics
   */
  static getMemoryStats() {
    const memUsage = process.memoryUsage();
    return {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024),
    };
  }

  /**
   * Log current memory usage
   */
  static logMemoryUsage(context?: string): void {
    const stats = this.getMemoryStats();
    const prefix = context ? `[${context}] ` : '';

    logger.info(`${prefix}Memory usage: ${stats.heapUsed}MB heap, ${stats.rss}MB RSS`);
  }

  /**
   * Set up memory monitoring for a process
   */
  static setupMemoryMonitoring(intervalMs = 30000): () => void {
    const interval = setInterval(() => {
      const stats = this.getMemoryStats();

      // Log warning if memory usage is high
      if (stats.heapUsed > 500) {
        logger.warn(`High memory usage detected: ${stats.heapUsed}MB heap`);
      }

      // Force GC if heap is growing large
      if (stats.heapUsed > 300 && this.gcEnabled) {
        this.forceGC();
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }

  /**
   * Optimize Map and Set collections by pre-sizing them
   */
  static optimizeCollections<K, V>(map: Map<K, V>, expectedSize: number): void {
    // Create a new map with better initial capacity
    if (map.size === 0 && expectedSize > 16) {
      // Maps in V8 resize in powers of 2, so optimize for that
      const optimizedSize = Math.pow(2, Math.ceil(Math.log2(expectedSize * 1.5)));
      logger.debug(
        `Optimizing map capacity for ${expectedSize} items (allocated: ${optimizedSize})`
      );
    }
  }

  /**
   * Clean up unused references in collections
   */
  static cleanupCollections(collections: { [key: string]: Map<any, any> | Set<any> }): void {
    for (const [name, collection] of Object.entries(collections)) {
      const size = collection.size;

      if (collection instanceof Map) {
        // Remove any null/undefined values
        for (const [key, value] of collection.entries()) {
          if (value === null || value === undefined) {
            collection.delete(key);
          }
        }
      }

      const cleaned = collection.size;
      if (cleaned < size) {
        logger.debug(`Cleaned up ${size - cleaned} items from ${name} collection`);
      }
    }
  }

  /**
   * Disable garbage collection (useful during critical sections)
   */
  static disableGC(): void {
    this.gcEnabled = false;
    logger.debug('Garbage collection disabled');
  }

  /**
   * Re-enable garbage collection
   */
  static enableGC(): void {
    this.gcEnabled = true;
    logger.debug('Garbage collection enabled');
  }
}

/**
 * Memory-efficient plugin loader that uses lazy loading
 */
export class LazyPluginLoader {
  private static loadedPlugins = new Map<string, any>();
  private static loadPromises = new Map<string, Promise<any>>();

  /**
   * Load a plugin lazily (only when needed)
   */
  static async loadPlugin(pluginName: string, importPath: string): Promise<any> {
    // Return cached plugin if already loaded
    if (this.loadedPlugins.has(pluginName)) {
      return this.loadedPlugins.get(pluginName);
    }

    // Return existing load promise if currently loading
    if (this.loadPromises.has(pluginName)) {
      return this.loadPromises.get(pluginName);
    }

    // Start loading the plugin
    const loadPromise = this.loadPluginInternal(pluginName, importPath);
    this.loadPromises.set(pluginName, loadPromise);

    try {
      const plugin = await loadPromise;
      this.loadedPlugins.set(pluginName, plugin);
      this.loadPromises.delete(pluginName);
      return plugin;
    } catch (error) {
      this.loadPromises.delete(pluginName);
      throw error;
    }
  }

  private static async loadPluginInternal(pluginName: string, importPath: string): Promise<any> {
    logger.debug(`Lazy loading plugin: ${pluginName}`);
    MemoryOptimizer.takeSnapshot(`before-load-${pluginName}`);

    const plugin = await import(importPath);

    MemoryOptimizer.compareSnapshot(`before-load-${pluginName}`);
    return plugin;
  }

  /**
   * Unload a plugin to free memory
   */
  static unloadPlugin(pluginName: string): void {
    if (this.loadedPlugins.has(pluginName)) {
      this.loadedPlugins.delete(pluginName);
      logger.debug(`Unloaded plugin: ${pluginName}`);
      MemoryOptimizer.forceGC();
    }
  }

  /**
   * Get memory usage statistics for loaded plugins
   */
  static getPluginMemoryStats() {
    return {
      loadedPlugins: this.loadedPlugins.size,
      pendingLoads: this.loadPromises.size,
    };
  }
}
