/**
 * Default Configuration
 * 
 * Defines the default values for the application configuration.
 * These values are used if not overridden by user configuration.
 */

import { ConfigType } from './schema.js';

/**
 * Default configuration values
 */
export const defaultConfig: Partial<ConfigType> = {
  // Basic configuration
  logLevel: 'info',
  
  // API configuration
  api: {
    baseUrl: 'https://api.anthropic.com',
    version: 'v1',
    timeout: 60000 // 60 seconds
  },
  
  // Telemetry configuration
  telemetry: {
    enabled: true,
    anonymizeData: true,
    errorReporting: true
  },
  
  // Terminal configuration
  terminal: {
    theme: 'system',
    showProgressIndicators: true,
    useColors: true,
    codeHighlighting: true
  },
  
  // Code analysis configuration
  codeAnalysis: {
    indexDepth: 3,
    excludePatterns: [
      'node_modules/**',
      '.git/**',
      'dist/**',
      'build/**',
      '**/*.min.js',
      '**/*.bundle.js',
      '**/vendor/**',
      '.DS_Store',
      '**/*.log',
      '**/*.lock',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '.env*',
      '**/*.map'
    ],
    includePatterns: ['**/*'],
    maxFileSize: 1024 * 1024, // 1MB
    scanTimeout: 30000 // 30 seconds
  },
  
  // Git configuration
  git: {
    preferredRemote: 'origin',
    useSsh: false,
    useGpg: false,
    signCommits: false
  },
  
  // Editor configuration
  editor: {
    tabWidth: 2,
    insertSpaces: true,
    formatOnSave: true
  },
  
  // Authentication related
  forceLogin: false,
  forceLogout: false,
  
  // Persistent data
  recentWorkspaces: []
}; 