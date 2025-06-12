import { logger } from '@elizaos/core';
import { CachedRegistry } from '../types/plugins';
import fs from 'node:fs/promises';
import path from 'node:path';
import { UserEnvironment } from './user-environment';

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

async function getCacheFile(): Promise<string> {
  try {
    const userEnv = UserEnvironment.getInstance();
    const pathInfo = await userEnv.getPathInfo();
    const cacheDir = path.join(pathInfo.elizaDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    return path.join(cacheDir, 'plugin-registry.json');
  } catch (error) {
    // Fallback to a temp file if we can't access .eliza directory
    logger.warn('Could not access .eliza cache directory, using fallback:', error);
    return path.join(process.cwd(), '.eliza-plugin-cache.json');
  }
}

interface CacheEntry {
  data: CachedRegistry;
  timestamp: number;
}

let memoryCache: CacheEntry | null = null;

/**
 * Check if cached data is still valid
 */
function isCacheValid(cacheEntry: CacheEntry | null): boolean {
  if (!cacheEntry) return false;
  return Date.now() - cacheEntry.timestamp < CACHE_TTL;
}

/**
 * Load cache from disk
 */
async function loadDiskCache(): Promise<CacheEntry | null> {
  try {
    const cacheFile = await getCacheFile();
    const cacheData = await fs.readFile(cacheFile, 'utf8');
    const parsed = JSON.parse(cacheData) as CacheEntry;
    return isCacheValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Save cache to disk
 */
async function saveDiskCache(data: CachedRegistry): Promise<void> {
  try {
    const cacheFile = await getCacheFile();
    const cacheEntry: CacheEntry = {
      data,
      timestamp: Date.now(),
    };
    await fs.writeFile(cacheFile, JSON.stringify(cacheEntry));
    memoryCache = cacheEntry;
  } catch (error) {
    logger.warn('Failed to save plugin registry cache:', error);
  }
}

/**
 * Fetch plugin registry from network
 */
async function fetchFromNetwork(): Promise<CachedRegistry | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const resp = await fetch(
      'https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/generated-registry.json',
      { 
        signal: controller.signal,
        headers: {
          'User-Agent': 'ElizaOS-CLI',
          'Cache-Control': 'no-cache',
        }
      }
    );
    
    clearTimeout(timeoutId);
    
    if (!resp.ok) {
      logger.error(`Failed to fetch plugin registry: ${resp.statusText}`);
      throw new Error(`Failed to fetch registry: ${resp.statusText}`);
    }
    
    const raw = await resp.json();
    const registry = raw as CachedRegistry;
    
    // Cache the result
    await saveDiskCache(registry);
    
    return registry;
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.error('Plugin registry fetch timed out');
    } else {
      logger.error('Plugin registry fetch failed:', error);
    }
    return null;
  }
}

export async function fetchPluginRegistry(): Promise<CachedRegistry | null> {
  // Check memory cache first
  if (isCacheValid(memoryCache)) {
    logger.debug('Using memory-cached plugin registry');
    return memoryCache!.data;
  }

  // Check disk cache
  const diskCache = await loadDiskCache();
  if (diskCache) {
    logger.debug('Using disk-cached plugin registry');
    memoryCache = diskCache;
    return diskCache.data;
  }

  // Fetch from network as last resort
  logger.debug('Fetching plugin registry from network');
  return await fetchFromNetwork();
}
