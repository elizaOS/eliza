/**
 * Execution Environment Module
 * 
 * Provides functionality for executing shell commands and scripts
 * in a controlled environment with proper error handling.
 */

import { exec, spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { createUserError } from '../errors/formatter.js';
import { ErrorCategory } from '../errors/types.js';
import { Timeout } from '../utils/types.js';

/**
 * Result of a command execution
 */
interface ExecutionResult {
  output: string;
  exitCode: number;
  error?: Error;
  command: string;
  duration: number;
}

/**
 * Command execution options
 */
interface ExecutionOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  shell?: string;
  maxBuffer?: number;
  captureStderr?: boolean;
}

/**
 * Background process options
 */
interface BackgroundProcessOptions extends ExecutionOptions {
  onOutput?: (output: string) => void;
  onError?: (error: string) => void;
  onExit?: (code: number | null) => void;
}

/**
 * Background process handle
 */
interface BackgroundProcess {
  pid: number;
  kill: () => boolean;
  isRunning: boolean;
}

/**
 * List of dangerous commands that shouldn't be executed
 */
const DANGEROUS_COMMANDS = [
  /^\s*rm\s+(-rf?|--recursive)\s+[\/~]/i, // rm -rf / or similar
  /^\s*dd\s+.*of=\/dev\/(disk|hd|sd)/i,   // dd to a device
  /^\s*mkfs/i,                           // Format a filesystem
  /^\s*:\(\)\{\s*:\|:\s*&\s*\}\s*;/,      // Fork bomb
  /^\s*>(\/dev\/sd|\/dev\/hd)/,           // Overwrite disk device
  /^\s*sudo\s+.*(rm|mkfs|dd|chmod|chown)/i // sudo with dangerous commands
];

/**
 * Maximum command execution time (30 seconds by default)
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * Maximum output buffer size (5MB by default)
 */
const DEFAULT_MAX_BUFFER = 5 * 1024 * 1024;

/**
 * Execution environment manager
 */
class ExecutionEnvironment {
  private config: any;
  private backgroundProcesses: Map<number, BackgroundProcess> = new Map();
  private executionCount: number = 0;
  private workingDirectory: string;
  private environmentVariables: Record<string, string>;

  /**
   * Create a new execution environment
   */
  constructor(config: any) {
    this.config = config;
    this.workingDirectory = config.execution?.cwd || process.cwd();
    
    // Set up environment variables
    this.environmentVariables = {
      ...process.env as Record<string, string>,
      CLAUDE_CODE_VERSION: config.version || '0.2.29',
      NODE_ENV: config.env || 'production',
      ...(config.execution?.env || {})
    };
    
    logger.debug('Execution environment created', {
      workingDirectory: this.workingDirectory
    });
  }

  /**
   * Initialize the execution environment
   */
  async initialize(): Promise<void> {
    logger.info('Initializing execution environment');
    
    try {
      // Verify shell is available
      const shell = this.config.execution?.shell || process.env.SHELL || 'bash';
      
      await this.executeCommand(`${shell} -c "echo Shell is available"`, {
        timeout: 5000
      });
      
      logger.info('Execution environment initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize execution environment', error);
      throw createUserError('Failed to initialize command execution environment', {
        cause: error,
        category: ErrorCategory.COMMAND_EXECUTION,
        resolution: 'Check that your shell is properly configured'
      });
    }
  }

  /**
   * Execute a shell command
   */
  async executeCommand(command: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    // Increment execution count
    this.executionCount++;
    
    // Validate command for safety
    this.validateCommand(command);
    
    const cwd = options.cwd || this.workingDirectory;
    const env = { ...this.environmentVariables, ...(options.env || {}) };
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const maxBuffer = options.maxBuffer || DEFAULT_MAX_BUFFER;
    const shell = options.shell || this.config.execution?.shell || process.env.SHELL || 'bash';
    const captureStderr = options.captureStderr !== false;
    
    logger.debug('Executing command', {
      command,
      cwd,
      shell,
      timeout,
      executionCount: this.executionCount
    });
    
    const startTime = Date.now();
    
    return new Promise<ExecutionResult>((resolve, reject) => {
      exec(command, {
        cwd,
        env,
        timeout,
        maxBuffer,
        shell,
        windowsHide: true,
        encoding: 'utf8'
      }, (error: Error | null, stdout: string, stderr: string) => {
        const duration = Date.now() - startTime;
        
        // Combine stdout and stderr if requested
        const output = captureStderr ? `${stdout}${stderr ? stderr : ''}` : stdout;
        
        if (error) {
          logger.error(`Command execution failed: ${command}`, {
            error: error.message,
            exitCode: (error as any).code,
            duration
          });
          
          // Format the error result
          resolve({
            output,
            exitCode: (error as any).code || 1,
            error,
            command,
            duration
          });
        } else {
          logger.debug(`Command executed successfully: ${command}`, {
            duration,
            outputLength: output.length
          });
          
          resolve({
            output,
            exitCode: 0,
            command,
            duration
          });
        }
      });
    });
  }

  /**
   * Execute a command in the background
   */
  executeCommandInBackground(command: string, options: BackgroundProcessOptions = {}): BackgroundProcess {
    // Validate command for safety
    this.validateCommand(command);
    
    const cwd = options.cwd || this.workingDirectory;
    const env = { ...this.environmentVariables, ...(options.env || {}) };
    const shell = options.shell || this.config.execution?.shell || process.env.SHELL || 'bash';
    
    logger.debug('Executing command in background', {
      command,
      cwd,
      shell
    });
    
    // Spawn the process
    const childProcess = spawn(command, [], {
      cwd,
      env,
      shell,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    const pid = childProcess.pid!;
    let isRunning = true;
    
    // Set up output handlers
    if (childProcess.stdout) {
      childProcess.stdout.on('data', (data: Buffer) => {
        const output = data.toString('utf8');
        logger.debug(`Background command (pid ${pid}) output:`, { output });
        
        if (options.onOutput) {
          options.onOutput(output);
        }
      });
    }
    
    if (childProcess.stderr) {
      childProcess.stderr.on('data', (data: Buffer) => {
        const errorOutput = data.toString('utf8');
        logger.debug(`Background command (pid ${pid}) error:`, { errorOutput });
        
        if (options.onError) {
          options.onError(errorOutput);
        }
      });
    }
    
    // Set up exit handler
    childProcess.on('exit', (code) => {
      isRunning = false;
      logger.debug(`Background command (pid ${pid}) exited with code ${code}`);
      
      // Remove from tracked processes
      this.backgroundProcesses.delete(pid);
      
      if (options.onExit) {
        options.onExit(code);
      }
    });
    
    // Create the process handle
    const backgroundProcess: BackgroundProcess = {
      pid,
      kill: () => {
        if (isRunning) {
          childProcess.kill();
          isRunning = false;
          this.backgroundProcesses.delete(pid);
          return true;
        }
        return false;
      },
      isRunning: true
    };
    
    // Track the process
    this.backgroundProcesses.set(pid, backgroundProcess);
    
    return backgroundProcess;
  }

  /**
   * Kill all running background processes
   */
  killAllBackgroundProcesses(): void {
    logger.info(`Killing ${this.backgroundProcesses.size} background processes`);
    
    for (const process of this.backgroundProcesses.values()) {
      try {
        process.kill();
      } catch (error) {
        logger.warn(`Failed to kill process ${process.pid}`, error);
      }
    }
    
    this.backgroundProcesses.clear();
  }

  /**
   * Validate a command for safety
   */
  private validateCommand(command: string): void {
    // Check if command is in the denied list
    for (const pattern of DANGEROUS_COMMANDS) {
      if (pattern.test(command)) {
        throw createUserError(`Command execution blocked: '${command}' matches dangerous pattern`, {
          category: ErrorCategory.COMMAND_EXECUTION,
          resolution: 'This command is blocked for safety reasons. Please use a different command.'
        });
      }
    }
    
    // Check if command is in allowed list (if configured)
    if (this.config.execution?.allowedCommands && this.config.execution.allowedCommands.length > 0) {
      const allowed = this.config.execution.allowedCommands.some(
        (allowedPattern: string | RegExp) => {
          if (typeof allowedPattern === 'string') {
            return command.startsWith(allowedPattern);
          } else {
            return allowedPattern.test(command);
          }
        }
      );
      
      if (!allowed) {
        throw createUserError(`Command execution blocked: '${command}' is not in the allowed list`, {
          category: ErrorCategory.COMMAND_EXECUTION,
          resolution: 'This command is not allowed by your configuration.'
        });
      }
    }
  }

  /**
   * Set the working directory
   */
  setWorkingDirectory(directory: string): void {
    this.workingDirectory = directory;
    logger.debug(`Working directory set to: ${directory}`);
  }

  /**
   * Get the working directory
   */
  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  /**
   * Set an environment variable
   */
  setEnvironmentVariable(name: string, value: string): void {
    this.environmentVariables[name] = value;
    logger.debug(`Environment variable set: ${name}=${value}`);
  }

  /**
   * Get an environment variable
   */
  getEnvironmentVariable(name: string): string | undefined {
    return this.environmentVariables[name];
  }
}

/**
 * Initialize the execution environment
 */
export async function initExecutionEnvironment(config: any): Promise<ExecutionEnvironment> {
  logger.info('Initializing execution environment');
  
  try {
    const executionEnv = new ExecutionEnvironment(config);
    await executionEnv.initialize();
    
    logger.info('Execution environment initialized successfully');
    
    return executionEnv;
  } catch (error) {
    logger.error('Failed to initialize execution environment', error);
    
    // Return a minimal execution environment even if initialization failed
    return new ExecutionEnvironment(config);
  }
}

// Set up cleanup on process exit
function setupProcessCleanup(executionEnv: ExecutionEnvironment): void {
  process.on('exit', () => {
    executionEnv.killAllBackgroundProcesses();
  });
  
  process.on('SIGINT', () => {
    executionEnv.killAllBackgroundProcesses();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    executionEnv.killAllBackgroundProcesses();
    process.exit(0);
  });
}

export { ExecutionResult, ExecutionOptions, BackgroundProcess, BackgroundProcessOptions };
export default ExecutionEnvironment; 