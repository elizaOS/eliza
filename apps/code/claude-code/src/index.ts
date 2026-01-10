/**
 * Claude Code CLI
 * 
 * Main entry point for the application.
 * This module bootstraps the application and manages the lifecycle.
 */

import { loadConfig } from './config/index.js';
import { initTerminal } from './terminal/index.js';
import { initAuthentication } from './auth/index.js';
import { initAI } from './ai/index.js';
import { initCodebaseAnalysis } from './codebase/index.js';
import { initCommandProcessor } from './commands/index.js';
import { initFileOperations } from './fileops/index.js';
import { initExecutionEnvironment } from './execution/index.js';
import { initErrorHandling } from './errors/index.js';
import { initTelemetry } from './telemetry/index.js';
import { logger } from './utils/logger.js';

/**
 * Application instance that holds references to all initialized subsystems
 */
export interface AppInstance {
  config: any;
  terminal: any;
  auth: any;
  ai: any;
  codebase: any;
  commands: any;
  fileOps: any;
  execution: any;
  errors: any;
  telemetry: any;
}

/**
 * Initialize all application subsystems
 */
export async function initialize(options: any = {}): Promise<AppInstance> {
  // Set up error handling first
  const errors = initErrorHandling();
  
  try {
    logger.info('Starting Claude Code CLI...');
    
    // Load configuration
    const config = await loadConfig(options);
    
    // Initialize terminal interface
    const terminal = await initTerminal(config);
    
    // Initialize authentication
    const auth = await initAuthentication(config);
    
    // Initialize AI client
    const ai = await initAI(config, auth);
    
    // Initialize codebase analysis
    const codebase = await initCodebaseAnalysis(config);
    
    // Initialize file operations
    const fileOps = await initFileOperations(config);
    
    // Initialize execution environment
    const execution = await initExecutionEnvironment(config);
    
    // Initialize command processor
    const commands = await initCommandProcessor(config, {
      terminal,
      auth,
      ai,
      codebase,
      fileOps,
      execution,
      errors
    });
    
    // Initialize telemetry if enabled
    const telemetry = config.telemetry.enabled 
      ? await initTelemetry(config) 
      : null;
    
    logger.info('Claude Code CLI initialized successfully');
    
    return {
      config,
      terminal,
      auth,
      ai,
      codebase,
      commands,
      fileOps,
      execution,
      errors,
      telemetry
    };
  } catch (error) {
    errors.handleFatalError(error);
    // This is just to satisfy TypeScript since handleFatalError will exit the process
    throw error;
  }
}

/**
 * Run the application main loop
 */
export async function run(app: AppInstance): Promise<void> {
  try {
    // Display welcome message
    app.terminal.displayWelcome();
    
    // Authenticate if needed
    if (!app.auth.isAuthenticated()) {
      await app.auth.authenticate();
    }
    
    // Start codebase analysis in the background
    app.codebase.startBackgroundAnalysis();
    
    // Enter the main command loop
    await app.commands.startCommandLoop();
    
    // Clean shutdown
    await shutdown(app);
  } catch (error) {
    app.errors.handleFatalError(error);
  }
}

/**
 * Gracefully shut down the application
 */
export async function shutdown(app: AppInstance): Promise<void> {
  logger.info('Shutting down Claude Code CLI...');
  
  // Stop background tasks and release resources
  await app.codebase.stopBackgroundAnalysis();
  
  // Submit telemetry if enabled
  if (app.telemetry) {
    await app.telemetry.submitTelemetry();
  }
  
  // Disconnect from services
  await app.ai.disconnect();
  
  logger.info('Claude Code CLI shutdown complete');
}

/**
 * Handle process signals for clean shutdown
 */
function setupProcessHandlers(app: AppInstance): void {
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT signal');
    await shutdown(app);
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM signal');
    await shutdown(app);
    process.exit(0);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection:', reason);
    app.errors.handleUnhandledRejection(reason, promise);
  });
  
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    app.errors.handleUncaughtException(error);
    process.exit(1);
  });
}

/**
 * Main entry point function
 */
export async function main(options: any = {}): Promise<void> {
  const app = await initialize(options);
  setupProcessHandlers(app);
  await run(app);
} 