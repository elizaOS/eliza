import { type Character, type IAgentRuntime, type Plugin } from '@elizaos/core';
import { type AgentServer } from '@elizaos/server';

/**
 * Start command options and interfaces
 */

/**
 * Options for starting agents
 */
export interface StartOptions {
  port?: number;
  configDir?: string;
}

/**
 * Agent start configuration
 */
export interface AgentStartConfig {
  character: Character;
  server: AgentServer;
  init?: (runtime: IAgentRuntime) => Promise<void>;
  plugins?: (Plugin | string)[];
  options?: AgentStartOptions;
}

/**
 * Agent start options
 */
export interface AgentStartOptions {
  isTestMode?: boolean;
}

/**
 * Plugin validation interface
 */
export interface PluginValidation {
  isValid: boolean;
  plugin?: Plugin;
  error?: string;
}

/**
 * Plugin context information
 */
export interface PluginContext {
  isLocalDevelopment: boolean;
  name: string;
  path?: string;
}

/**
 * Server startup configuration
 */
export interface ServerConfig {
  port: number;
  configDir?: string;
  skipBuild?: boolean;
}

/**
 * Runtime configuration
 */
export interface RuntimeConfig {
  plugins: Plugin[];
  character: Character;
  server: AgentServer;
}
