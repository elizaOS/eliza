import { logger } from '@elizaos/core';

/**
 * Utility functions for Claude SDK management and validation
 */

// Type definitions for Claude SDK
export interface SDKMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
}

export interface ClaudeQueryOptions {
  maxTurns: number;
  model?: string;
  systemPrompt?: string;
  outputFormat?: string;
  permissionMode?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
}

export interface ClaudeQueryParams {
  prompt: string;
  abortController: AbortController;
  options: ClaudeQueryOptions;
  cwd: string;
}

export interface ClaudeSDKModule {
  query: (params: ClaudeQueryParams) => AsyncIterable<SDKMessage>;
}

/**
 * Safely import and validate Claude SDK
 */
export async function importClaudeSDK(): Promise<ClaudeSDKModule> {
  try {
    logger.debug('Attempting to import Claude Code SDK...');
    
    // Dynamic import with TypeScript suppression for optional dependency
    const moduleName = '@anthropic-ai/claude-code';
    const claudeModule = await import(moduleName) as ClaudeSDKModule;
    
    // Validate the module has the expected interface
    if (!claudeModule.query || typeof claudeModule.query !== 'function') {
      throw new Error('Claude SDK module is invalid - missing query function');
    }
    
    logger.debug('✅ Claude Code SDK imported successfully');
    return claudeModule;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (errorMessage.includes('Cannot resolve module') || 
        errorMessage.includes('Module not found') ||
        errorMessage.includes('@anthropic-ai/claude-code')) {
      
      logger.error('❌ Claude Code SDK not installed');
      throw new Error('Claude Code SDK is required but not installed. Please install with: bun add @anthropic-ai/claude-code');
    }
    
    logger.error('❌ Failed to import Claude SDK:', errorMessage);
    throw new Error(`Failed to import Claude SDK: ${errorMessage}`);
  }
}

/**
 * Check if Claude SDK is available without importing it
 */
export async function isClaudeSDKAvailable(): Promise<boolean> {
  try {
    await importClaudeSDK();
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate environment requirements for Claude SDK
 */
export function validateClaudeSDKEnvironment(): void {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required for Claude SDK');
  }
  
  if (apiKey.length < 10) {
    throw new Error('ANTHROPIC_API_KEY appears to be invalid (too short)');
  }
  
  logger.debug('✅ Claude SDK environment validated');
}

/**
 * Get SDK error context for better error messages
 */
export function getSDKErrorContext(error: unknown): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  if (errorMessage.includes('rate limit')) {
    return 'Rate limit exceeded. Please wait before retrying.';
  }
  
  if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
    return 'Invalid API key. Please check your ANTHROPIC_API_KEY environment variable.';
  }
  
  if (errorMessage.includes('403') || errorMessage.includes('forbidden')) {
    return 'API access denied. Please check your API key permissions.';
  }
  
  if (errorMessage.includes('429')) {
    return 'Too many requests. Please reduce request frequency.';
  }
  
  if (errorMessage.includes('timeout')) {
    return 'Request timed out. Please try again.';
  }
  
  return errorMessage;
} 