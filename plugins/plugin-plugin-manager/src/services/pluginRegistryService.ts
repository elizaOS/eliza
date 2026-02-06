import { logger } from '@elizaos/core';
import { PluginMetadata } from '../types';

const API_SERVICE_URL = process.env.ELIZAOS_API_URL || 'http://localhost:3000/api';
const API_KEY = process.env.ELIZAOS_API_KEY || '';

export interface PluginSearchResult {
  id?: string;
  name: string;
  description: string;
  score?: number;
  tags?: string[];
  features?: string[];
  requiredConfig?: string[];
  version?: string;
  npmPackage?: string;
  repository?: string;
  relevantSection?: string;
}

export interface PluginDetails {
  id?: string;
  name: string;
  description: string;
  readme?: string;
  capabilitiesSummary?: string;
  repository?: string;
  version?: string;
  tags?: string[];
  features?: string[];
  requiredConfig?: string[];
  dependencies?: Record<string, string>;
  dependedBy?: string[];
  npmPackage?: string;
  installCount?: number;
  searchCount?: number;
  categories?: string[];
  lastIndexed?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CloneResult {
  success: boolean;
  error?: string;
  pluginName?: string;
  localPath?: string;
  hasTests?: boolean;
  dependencies?: Record<string, string>;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const url = `${API_SERVICE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEY}`,
    ...options.headers,
  };

  try {
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(
        `[pluginRegistryService] API request to ${url} failed with status ${response.status}: ${errorBody}`
      );
      throw new Error(`API request failed: ${response.statusText}`);
    }
    return response.json() as Promise<ApiResponse<T>>;
  } catch (error) {
    logger.error(`[pluginRegistryService] Network error calling ${url}:`, error);
    throw error;
  }
}

export async function searchPluginsByContent(query: string): Promise<PluginSearchResult[]> {
  logger.info(`[pluginRegistryService] Searching for plugins matching: ${query}`);
  try {
    const data = await apiFetch<PluginSearchResult[]>('/plugins/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit: 10 }),
    });
    return data.data || [];
  } catch (error) {
    return [];
  }
}

export async function getPluginDetails(name: string): Promise<PluginMetadata | null> {
  logger.info(`[pluginRegistryService] Getting details for plugin: ${name}`);
  try {
    const data = await apiFetch<PluginMetadata>(`/plugins/${encodeURIComponent(name)}`, {
      method: 'GET',
    });
    return data.data || null;
  } catch (error) {
    return null;
  }
}

export async function getAllPlugins(): Promise<PluginMetadata[]> {
  logger.info('[pluginRegistryService] Getting all plugins from registry');
  try {
    const data = await apiFetch<PluginMetadata[]>('/plugins', {
      method: 'GET',
    });
    return data.data || [];
  } catch (error) {
    return [];
  }
}

export async function getPluginsByCategory(category: string): Promise<PluginMetadata[]> {
  logger.info(`[pluginRegistryService] Getting plugins for category: ${category}`);
  try {
    const data = await apiFetch<PluginMetadata[]>(
      `/plugins?category=${encodeURIComponent(category)}`,
      {
        method: 'GET',
      }
    );
    return data.data || [];
  } catch (error) {
    return [];
  }
}

export async function clonePlugin(pluginName: string): Promise<CloneResult> {
  logger.info(`[pluginRegistryService] Cloning plugin: ${pluginName}`);

  const plugin = await getPluginDetails(pluginName);
  if (!plugin || !plugin.repository) {
    return {
      success: false,
      error: `Plugin "${pluginName}" not found in registry or has no repository`,
    };
  }

  try {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const cloneDir = path.join(
      process.cwd(),
      'cloned-plugins',
      plugin.name.replace('@elizaos/', '')
    );

    await fs.mkdir(cloneDir, { recursive: true });
    await execAsync(`git clone ${plugin.repository} ${cloneDir}`);

    const packageJsonPath = path.join(cloneDir, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    const hasTests = !!(packageJson.scripts?.test || packageJson.devDependencies?.vitest);

    return {
      success: true,
      pluginName: plugin.name,
      localPath: cloneDir,
      hasTests,
      dependencies: packageJson.dependencies || {},
    };
  } catch (error) {
    logger.error('[pluginRegistryService] Clone failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during clone',
    };
  }
}
