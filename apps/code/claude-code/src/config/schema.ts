/**
 * Configuration Schema
 * 
 * Defines the structure and validation rules for the application configuration.
 * Uses Zod for runtime type validation.
 */

import { z } from 'zod';

// Define log level enum
const LogLevel = z.enum(['error', 'warn', 'info', 'verbose', 'debug', 'trace']);

// API configuration schema
const ApiConfigSchema = z.object({
  key: z.string().optional(),
  baseUrl: z.string().url().optional(),
  version: z.string().optional(),
  timeout: z.number().positive().optional()
});

// Telemetry configuration schema
const TelemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  anonymizeData: z.boolean().default(true),
  errorReporting: z.boolean().default(true)
});

// Terminal configuration schema
const TerminalConfigSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('system'),
  showProgressIndicators: z.boolean().default(true),
  useColors: z.boolean().default(true),
  codeHighlighting: z.boolean().default(true),
  maxHeight: z.number().positive().optional(),
  maxWidth: z.number().positive().optional()
});

// Code analysis configuration schema
const CodeAnalysisConfigSchema = z.object({
  indexDepth: z.number().int().positive().default(3),
  excludePatterns: z.array(z.string()).default([
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '**/*.min.js',
    '**/*.bundle.js'
  ]),
  includePatterns: z.array(z.string()).default(['**/*']),
  maxFileSize: z.number().int().positive().default(1024 * 1024), // 1MB
  scanTimeout: z.number().int().positive().default(30000) // 30s
});

// Git configuration schema
const GitConfigSchema = z.object({
  preferredRemote: z.string().default('origin'),
  preferredBranch: z.string().optional(),
  useSsh: z.boolean().default(false),
  useGpg: z.boolean().default(false),
  signCommits: z.boolean().default(false)
});

// Editor configuration schema
const EditorConfigSchema = z.object({
  preferredLauncher: z.string().optional(),
  tabWidth: z.number().int().positive().default(2),
  insertSpaces: z.boolean().default(true),
  formatOnSave: z.boolean().default(true)
});

// Paths configuration schema - will be populated at runtime
const PathsConfigSchema = z.object({
  home: z.string().optional(),
  app: z.string().optional(),
  cache: z.string().optional(),
  logs: z.string().optional(),
  workspace: z.string().optional()
});

// Main configuration schema
export const configSchema = z.object({
  // Basic configuration
  workspace: z.string().optional(),
  logLevel: LogLevel.default('info'),
  
  // Subsystem configurations
  api: ApiConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  terminal: TerminalConfigSchema.default({}),
  codeAnalysis: CodeAnalysisConfigSchema.default({}),
  git: GitConfigSchema.default({}),
  editor: EditorConfigSchema.default({}),
  
  // Runtime configuration
  paths: PathsConfigSchema.optional(),
  
  // Authentication related
  forceLogin: z.boolean().default(false),
  forceLogout: z.boolean().default(false),
  
  // Persistent data
  lastUpdateCheck: z.number().optional(),
  auth: z.object({
    tokens: z.record(z.string()).optional(),
    lastAuth: z.number().optional()
  }).optional(),
  recentWorkspaces: z.array(z.string()).default([])
});

// Type definition generated from schema
export type ConfigType = z.infer<typeof configSchema>;

// Export sub-schemas for modular validation
export { 
  LogLevel,
  ApiConfigSchema,
  TelemetryConfigSchema,
  TerminalConfigSchema,
  CodeAnalysisConfigSchema,
  GitConfigSchema,
  EditorConfigSchema,
  PathsConfigSchema
}; 