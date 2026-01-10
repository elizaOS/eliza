/**
 * Configuration Module
 * 
 * Handles loading, validating, and providing access to application configuration.
 * Supports multiple sources like environment variables, config files, and CLI arguments.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  // API configuration
  api: {
    baseUrl: 'https://api.anthropic.com',
    version: 'v1',
    timeout: 60000
  },
  
  // AI configuration
  ai: {
    model: 'claude-3-opus-20240229',
    temperature: 0.5,
    maxTokens: 4096,
    maxHistoryLength: 20
  },
  
  // Authentication configuration
  auth: {
    autoRefresh: true,
    tokenRefreshThreshold: 300, // 5 minutes
    maxRetryAttempts: 3
  },
  
  // Terminal configuration
  terminal: {
    theme: 'system',
    useColors: true,
    showProgressIndicators: true,
    codeHighlighting: true
  },
  
  // Telemetry configuration
  telemetry: {
    enabled: true,
    submissionInterval: 30 * 60 * 1000, // 30 minutes
    maxQueueSize: 100,
    autoSubmit: true
  },
  
  // File operation configuration
  fileOps: {
    maxReadSizeBytes: 10 * 1024 * 1024 // 10MB
  },
  
  // Execution configuration
  execution: {
    shell: process.env.SHELL || 'bash'
  },
  
  // Logger configuration
  logger: {
    level: 'info',
    timestamps: true,
    colors: true
  },
  
  // App information
  version: '0.2.29'
};

/**
 * Configuration file paths to check
 */
const CONFIG_PATHS = [
  // Current directory
  path.join(process.cwd(), '.claude-code.json'),
  path.join(process.cwd(), '.claude-code.js'),
  
  // User home directory
  path.join(os.homedir(), '.claude-code', 'config.json'),
  path.join(os.homedir(), '.claude-code.json'),
  
  // XDG config directory (Linux/macOS)
  process.env.XDG_CONFIG_HOME 
    ? path.join(process.env.XDG_CONFIG_HOME, 'claude-code', 'config.json')
    : path.join(os.homedir(), '.config', 'claude-code', 'config.json'),
  
  // AppData directory (Windows)
  process.env.APPDATA
    ? path.join(process.env.APPDATA, 'claude-code', 'config.json')
    : null
].filter(Boolean) as string[];

/**
 * Load configuration from a file
 */
function loadConfigFromFile(configPath: string): any {
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    
    logger.debug(`Loading configuration from ${configPath}`);
    
    if (configPath.endsWith('.js')) {
      // Load JavaScript module
      const configModule = require(configPath);
      return configModule.default || configModule;
    } else {
      // Load JSON file
      const configContent = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(configContent);
    }
  } catch (error) {
    logger.warn(`Error loading configuration from ${configPath}`, error);
    return null;
  }
}

/**
 * Load configuration from environment variables
 */
function loadConfigFromEnv(): any {
  const envConfig: any = {};
  
  // Check for API key
  if (process.env.CLAUDE_API_KEY) {
    envConfig.api = envConfig.api || {};
    envConfig.api.key = process.env.CLAUDE_API_KEY;
  }
  
  // Check for API URL
  if (process.env.CLAUDE_API_URL) {
    envConfig.api = envConfig.api || {};
    envConfig.api.baseUrl = process.env.CLAUDE_API_URL;
  }
  
  // Check for log level
  if (process.env.CLAUDE_LOG_LEVEL) {
    envConfig.logger = envConfig.logger || {};
    envConfig.logger.level = process.env.CLAUDE_LOG_LEVEL;
  }
  
  // Check for telemetry opt-out
  if (process.env.CLAUDE_TELEMETRY === '0' || process.env.CLAUDE_TELEMETRY === 'false') {
    envConfig.telemetry = envConfig.telemetry || {};
    envConfig.telemetry.enabled = false;
  }
  
  // Check for model override
  if (process.env.CLAUDE_MODEL) {
    envConfig.ai = envConfig.ai || {};
    envConfig.ai.model = process.env.CLAUDE_MODEL;
  }
  
  return envConfig;
}

/**
 * Merge configuration objects
 */
function mergeConfigs(...configs: any[]): any {
  const result: any = {};
  
  for (const config of configs) {
    if (!config) continue;
    
    for (const key of Object.keys(config)) {
      const value = config[key];
      
      if (value === null || value === undefined) {
        continue;
      }
      
      if (typeof value === 'object' && !Array.isArray(value) && value !== null) {
        // Recursively merge objects
        result[key] = mergeConfigs(result[key] || {}, value);
      } else {
        // Overwrite primitives, arrays, etc.
        result[key] = value;
      }
    }
  }
  
  return result;
}

/**
 * Validate critical configuration
 */
function validateConfig(config: any): void {
  // Validate API configuration
  if (!config.api.baseUrl) {
    throw createUserError('API base URL is not configured', {
      category: ErrorCategory.CONFIGURATION,
      resolution: 'Provide a valid API base URL in your configuration'
    });
  }
  
  // Validate authentication
  if (!config.api.key && !config.auth.token) {
    logger.warn('No API key or authentication token configured');
  }
  
  // Validate AI model
  if (!config.ai.model) {
    throw createUserError('AI model is not configured', {
      category: ErrorCategory.CONFIGURATION,
      resolution: 'Specify a valid Claude model in your configuration'
    });
  }
}

/**
 * Load configuration
 */
export async function loadConfig(options: any = {}): Promise<any> {
  logger.debug('Loading configuration', { options });
  
  // Initialize with defaults
  let config = { ...DEFAULT_CONFIG };
  
  // Load configuration from files
  for (const configPath of CONFIG_PATHS) {
    const fileConfig = loadConfigFromFile(configPath);
    if (fileConfig) {
      config = mergeConfigs(config, fileConfig);
      logger.debug(`Loaded configuration from ${configPath}`);
      break; // Stop after first successful load
    }
  }
  
  // Load configuration from environment variables
  const envConfig = loadConfigFromEnv();
  config = mergeConfigs(config, envConfig);
  
  // Override with command line options
  if (options) {
    const cliConfig: any = {};
    
    // Map CLI flags to configuration
    if (options.verbose) {
      cliConfig.logger = { level: 'debug' };
    }
    
    if (options.quiet) {
      cliConfig.logger = { level: 'error' };
    }
    
    if (options.debug) {
      cliConfig.logger = { level: 'debug' };
    }
    
    if (options.config) {
      // Load from specified config file
      const customConfig = loadConfigFromFile(options.config);
      if (customConfig) {
        config = mergeConfigs(config, customConfig);
      } else {
        throw createUserError(`Could not load configuration from ${options.config}`, {
          category: ErrorCategory.CONFIGURATION,
          resolution: 'Check that the file exists and is valid JSON or JavaScript'
        });
      }
    }
    
    // Merge CLI options
    config = mergeConfigs(config, cliConfig);
  }
  
  // Validate the configuration
  validateConfig(config);
  
  // Configure logger
  import('../utils/logger.js').then(loggerModule => {
    if (loggerModule.configureLogger) {
      loggerModule.configureLogger(config);
    }
  }).catch(error => {
    logger.warn('Failed to configure logger', error);
  });
  
  return config;
}

export default { loadConfig }; 