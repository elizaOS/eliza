import { logger } from '@elizaos/core';
import { PluginMetadata } from '../types';

const API_SERVICE_URL = process.env.ELIZAOS_API_URL || 'https://www.dev.elizacloud.ai/api';
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

/**
 * Result wrapper that distinguishes between "no data" and "API failed"
 */
export interface RegistryResult<T> {
  data: T;
  fromApi: boolean;
  error?: string;
}

async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
  const url = `${API_SERVICE_URL}${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `API request to ${endpoint} failed (${response.status}): ${errorBody || response.statusText}`
    );
  }
  return response.json() as Promise<ApiResponse<T>>;
}

export async function searchPluginsByContent(
  query: string
): Promise<RegistryResult<PluginSearchResult[]>> {
  logger.info(`[pluginRegistryService] Searching for plugins matching: ${query}`);
  try {
    const data = await apiFetch<PluginSearchResult[]>('/plugins/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit: 10 }),
    });
    return { data: data.data || [], fromApi: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`[pluginRegistryService] Search failed: ${message}`);
    return { data: [], fromApi: false, error: message };
  }
}

export async function getPluginDetails(
  name: string
): Promise<RegistryResult<PluginMetadata | null>> {
  logger.info(`[pluginRegistryService] Getting details for plugin: ${name}`);
  try {
    const data = await apiFetch<PluginMetadata>(`/plugins/${encodeURIComponent(name)}`, {
      method: 'GET',
    });
    return { data: data.data || null, fromApi: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`[pluginRegistryService] Get details failed: ${message}`);
    return { data: null, fromApi: false, error: message };
  }
}

export async function getAllPlugins(): Promise<RegistryResult<PluginMetadata[]>> {
  logger.info('[pluginRegistryService] Getting all plugins from registry');
  try {
    const data = await apiFetch<PluginMetadata[]>('/plugins', {
      method: 'GET',
    });
    return { data: data.data || [], fromApi: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`[pluginRegistryService] Get all plugins failed: ${message}`);
    return { data: [], fromApi: false, error: message };
  }
}

export async function clonePlugin(pluginName: string): Promise<CloneResult> {
  logger.info(`[pluginRegistryService] Cloning plugin: ${pluginName}`);

  const result = await getPluginDetails(pluginName);
  if (!result.fromApi) {
    return {
      success: false,
      error: `Cannot reach plugin registry: ${result.error}`,
    };
  }
  if (!result.data || !result.data.repository) {
    return {
      success: false,
      error: `Plugin "${pluginName}" not found in registry or has no repository`,
    };
  }

  const plugin = result.data;

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

    // Read package.json if it exists - repos may be monorepos or lack a root package.json
    let hasTests = false;
    let dependencies: Record<string, string> = {};
    const packageJsonPath = path.join(cloneDir, 'package.json');
    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      hasTests = !!(packageJson.scripts?.test || packageJson.devDependencies?.vitest);
      dependencies = packageJson.dependencies || {};
    } catch {
      logger.warn(`[pluginRegistryService] No package.json at repo root for ${plugin.name}`);
    }

    return {
      success: true,
      pluginName: plugin.name,
      localPath: cloneDir,
      hasTests,
      dependencies,
    };
  } catch (error) {
    logger.error('[pluginRegistryService] Clone failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during clone',
    };
  }
}
