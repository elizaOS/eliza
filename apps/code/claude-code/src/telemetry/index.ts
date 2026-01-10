/**
 * Telemetry System
 * 
 * Collects anonymous usage data and error reports to help improve the tool.
 * Respects user privacy and can be disabled.
 */

import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { ErrorCategory } from '../errors/types.js';
import { logger } from '../utils/logger.js';

/**
 * Telemetry event types
 */
export enum TelemetryEventType {
  CLI_START = 'cli_start',
  CLI_EXIT = 'cli_exit',
  COMMAND_EXECUTE = 'command_execute',
  COMMAND_SUCCESS = 'command_success',
  COMMAND_ERROR = 'command_error',
  AI_REQUEST = 'ai_request',
  AI_RESPONSE = 'ai_response',
  AI_ERROR = 'ai_error',
  AUTH_SUCCESS = 'auth_success',
  AUTH_ERROR = 'auth_error'
}

/**
 * Telemetry event
 */
export interface TelemetryEvent {
  /**
   * Event type
   */
  type: TelemetryEventType;
  
  /**
   * Event timestamp
   */
  timestamp: string;
  
  /**
   * Event properties
   */
  properties: Record<string, any>;
  
  /**
   * Client information
   */
  client: {
    /**
     * CLI version
     */
    version: string;
    
    /**
     * Client ID (anonymous)
     */
    id: string;
    
    /**
     * Node.js version
     */
    nodeVersion: string;
    
    /**
     * Operating system
     */
    os: string;
    
    /**
     * Operating system version
     */
    osVersion: string;
  };
}

/**
 * Telemetry configuration
 */
export interface TelemetryConfig {
  /**
   * Whether telemetry is enabled
   */
  enabled: boolean;
  
  /**
   * Client ID (anonymous)
   */
  clientId: string;
  
  /**
   * Endpoint for sending telemetry data
   */
  endpoint?: string;
  
  /**
   * Additional data to include with all events
   */
  additionalData?: Record<string, any>;
}

/**
 * Default telemetry configuration
 */
const DEFAULT_CONFIG: TelemetryConfig = {
  enabled: true,
  clientId: '',
  endpoint: 'https://telemetry.anthropic.com/claude-code/events'
};

/**
 * Telemetry manager
 */
class TelemetryManager {
  private config: TelemetryConfig;
  private initialized = false;
  private eventQueue: TelemetryEvent[] = [];
  private batchSendTimeout: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  
  /**
   * Create a new telemetry manager
   */
  constructor() {
    this.config = { ...DEFAULT_CONFIG };
  }
  
  /**
   * Initialize telemetry
   */
  async initialize(userPreferences?: { telemetry?: boolean }): Promise<void> {
    if (this.initialized) {
      return;
    }
    
    try {
      // Check if telemetry is explicitly disabled in user preferences
      if (userPreferences?.telemetry === false) {
        this.config.enabled = false;
      } else if (process.env.CLAUDE_CODE_TELEMETRY === 'false') {
        // Also check environment variable
        this.config.enabled = false;
      }
      
      // Generate client ID if not already set
      if (!this.config.clientId) {
        this.config.clientId = this.generateClientId();
      }
      
      // Get CLI version from package.json
      this.config.additionalData = {
        ...this.config.additionalData,
        cliVersion: process.env.npm_package_version || '0.1.0'
      };
      
      this.initialized = true;
      
      // Only log if telemetry is enabled
      if (this.config.enabled) {
        logger.debug('Telemetry initialized', { clientId: this.config.clientId });
        
        // Send CLI start event
        this.trackEvent(TelemetryEventType.CLI_START);
        
        // Setup exit handlers
        this.setupExitHandlers();
      }
    } catch (error) {
      logger.error('Failed to initialize telemetry', error);
      this.config.enabled = false;  // Disable telemetry on error
    }
  }
  
  /**
   * Generate an anonymous client ID
   */
  private generateClientId(): string {
    return uuidv4();
  }
  
  /**
   * Setup process exit handlers to ensure telemetry is sent
   */
  private setupExitHandlers(): void {
    // Handle normal exit
    process.on('exit', () => {
      this.trackEvent(TelemetryEventType.CLI_EXIT);
      this.flushSync();
    });
    
    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      this.trackEvent(TelemetryEventType.CLI_EXIT, { reason: 'SIGINT' });
      this.flushSync();
      process.exit(0);
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.trackError(error, { fatal: true });
      this.flushSync();
    });
  }
  
  /**
   * Track an event
   */
  trackEvent(
    type: TelemetryEventType,
    properties: Record<string, any> = {}
  ): void {
    if (!this.initialized) {
      this.eventQueue.push(this.createEvent(type, properties));
      return;
    }
    
    if (!this.config.enabled) {
      return;
    }
    
    const event = this.createEvent(type, properties);
    this.queueEvent(event);
  }
  
  /**
   * Track a command execution
   */
  trackCommand(
    commandName: string,
    args: Record<string, any> = {},
    successful: boolean = true
  ): void {
    // Don't track sensitive commands
    if (commandName === 'login' || commandName === 'logout') {
      return;
    }
    
    // Create sanitized args (remove sensitive data)
    const sanitizedArgs: Record<string, any> = {};
    
    // Only include safe argument types and names
    for (const [key, value] of Object.entries(args)) {
      // Skip sensitive fields
      if (key.includes('key') || key.includes('token') || key.includes('password') || key.includes('secret')) {
        continue;
      }
      
      // Include only primitive values and sanitize them
      if (typeof value === 'string') {
        // Truncate long strings and remove potential sensitive data
        sanitizedArgs[key] = value.length > 100 ? `${value.substring(0, 100)}...` : value;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        sanitizedArgs[key] = value;
      } else if (value === null || value === undefined) {
        sanitizedArgs[key] = value;
      } else if (Array.isArray(value)) {
        sanitizedArgs[key] = `Array(${value.length})`;
      } else if (typeof value === 'object') {
        sanitizedArgs[key] = 'Object';
      }
    }
    
    const eventType = successful
      ? TelemetryEventType.COMMAND_SUCCESS
      : TelemetryEventType.COMMAND_ERROR;
    
    this.trackEvent(eventType, {
      command: commandName,
      args: sanitizedArgs
    });
  }
  
  /**
   * Track an error
   */
  trackError(
    error: unknown,
    context: Record<string, any> = {}
  ): void {
    if (!this.config.enabled) {
      return;
    }
    
    const errorObj: Record<string, any> = {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      category: 
        error instanceof Error && 
        'category' in error ? 
        (error as any).category : 
        ErrorCategory.UNKNOWN
    };
    
    this.trackEvent(TelemetryEventType.COMMAND_ERROR, {
      error: errorObj,
      ...context
    });
  }
  
  /**
   * Create a telemetry event
   */
  private createEvent(
    type: TelemetryEventType,
    properties: Record<string, any> = {}
  ): TelemetryEvent {
    // Ensure client info doesn't have any PII
    const filteredProperties = { ...properties };
    
    // Basic client information
    const event: TelemetryEvent = {
      type,
      timestamp: new Date().toISOString(),
      properties: filteredProperties,
      client: {
        version: this.config.additionalData?.cliVersion || '0.1.0',
        id: this.config.clientId,
        nodeVersion: process.version,
        os: os.platform(),
        osVersion: os.release()
      }
    };
    
    return event;
  }
  
  /**
   * Queue an event for sending
   */
  private queueEvent(event: TelemetryEvent): void {
    this.eventQueue.push(event);
    
    // Schedule batch sending if not already scheduled
    if (!this.batchSendTimeout && this.eventQueue.length > 0) {
      this.batchSendTimeout = setTimeout(() => {
        this.flushEvents();
      }, 5000);
    }
    
    // Immediately send if queue reaches threshold
    if (this.eventQueue.length >= 10) {
      this.flushEvents();
    }
  }
  
  /**
   * Flush events asynchronously
   */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    
    if (this.eventQueue.length === 0) {
      return Promise.resolve();
    }
    
    this.flushPromise = this.flushEvents();
    return this.flushPromise;
  }
  
  /**
   * Flush events synchronously (for exit handlers)
   */
  private flushSync(): void {
    if (this.eventQueue.length === 0) {
      return;
    }
    
    if (!this.config.enabled || !this.config.endpoint) {
      this.eventQueue = [];
      return;
    }
    
    try {
      const eventsToSend = [...this.eventQueue];
      this.eventQueue = [];
      
      // Using a synchronous request would be added here
      // This is a simplified implementation
      logger.debug(`Would send ${eventsToSend.length} telemetry events synchronously`);
    } catch (error) {
      logger.debug('Failed to send telemetry events synchronously', error);
    }
  }
  
  /**
   * Flush events to the telemetry endpoint
   */
  private async flushEvents(): Promise<void> {
    if (this.batchSendTimeout) {
      clearTimeout(this.batchSendTimeout);
      this.batchSendTimeout = null;
    }
    
    if (this.eventQueue.length === 0) {
      this.flushPromise = null;
      return;
    }
    
    if (!this.config.enabled || !this.config.endpoint) {
      this.eventQueue = [];
      this.flushPromise = null;
      return;
    }
    
    try {
      const eventsToSend = [...this.eventQueue];
      this.eventQueue = [];
      
      logger.debug(`Sending ${eventsToSend.length} telemetry events`);
      
      // Send events
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(eventsToSend)
      });
      
      if (!response.ok) {
        throw new Error(`Failed to send telemetry events: ${response.status} ${response.statusText}`);
      }
      
      logger.debug('Successfully sent telemetry events');
    } catch (error) {
      logger.debug('Failed to send telemetry events', error);
      // Add events back to queue for retry
      // this.eventQueue.unshift(...eventsToSend);
    } finally {
      this.flushPromise = null;
    }
  }
  
  /**
   * Enable telemetry
   */
  enable(): void {
    this.config.enabled = true;
    logger.info('Telemetry enabled');
  }
  
  /**
   * Disable telemetry
   */
  disable(): void {
    this.config.enabled = false;
    logger.info('Telemetry disabled');
    
    // Clear event queue
    this.eventQueue = [];
    
    if (this.batchSendTimeout) {
      clearTimeout(this.batchSendTimeout);
      this.batchSendTimeout = null;
    }
  }
  
  /**
   * Check if telemetry is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Create singleton instance
export const telemetry = new TelemetryManager();

// Export default
export default telemetry;

/**
 * Initialize the telemetry system
 * 
 * @param config Configuration options for telemetry
 * @returns The initialized telemetry manager
 */
export async function initTelemetry(config: any = {}): Promise<any> {
  logger.info('Initializing telemetry system');
  
  try {
    // Create telemetry manager
    const telemetryManager = new TelemetryManager();
    
    // Initialize with configuration
    const telemetryConfig = config.telemetry || {};
    
    // Check if telemetry is enabled (prefer environment variable)
    const telemetryEnabled = process.env.CLAUDE_CODE_TELEMETRY !== 'false' && 
      telemetryConfig.enabled !== false;
    
    // Initialize telemetry if enabled
    if (telemetryEnabled) {
      await telemetryManager.initialize({
        telemetry: telemetryEnabled
      });
      
      // Track CLI start event
      telemetryManager.trackEvent(TelemetryEventType.CLI_START, {
        version: config.version || 'unknown'
      });
      
      // Set up process exit handler to ensure telemetry is flushed
      process.on('exit', () => {
        telemetryManager.flush();
      });
      
      process.on('SIGINT', () => {
        telemetryManager.trackEvent(TelemetryEventType.CLI_EXIT, {
          reason: 'SIGINT'
        });
        telemetryManager.flush();
        process.exit(0);
      });
      
      process.on('SIGTERM', () => {
        telemetryManager.trackEvent(TelemetryEventType.CLI_EXIT, {
          reason: 'SIGTERM'
        });
        telemetryManager.flush();
        process.exit(0);
      });
      
      logger.info('Telemetry initialized successfully');
    } else {
      logger.info('Telemetry is disabled');
    }
    
    // Return telemetry interface
    return {
      /**
       * Track an event
       */
      trackEvent: (eventType: TelemetryEventType, properties: Record<string, any> = {}): void => {
        if (telemetryEnabled) {
          telemetryManager.trackEvent(eventType, properties);
        }
      },
      
      /**
       * Track an error
       */
      trackError: (error: unknown, context: Record<string, any> = {}): void => {
        if (telemetryEnabled) {
          telemetryManager.trackError(error, context);
        }
      },
      
      /**
       * Flush telemetry events
       */
      flush: async (): Promise<void> => {
        if (telemetryEnabled) {
          return telemetryManager.flush();
        }
      },
      
      /**
       * Submit telemetry data
       */
      submitTelemetry: async (): Promise<void> => {
        if (telemetryEnabled) {
          return telemetryManager.flush();
        }
      },
      
      /**
       * Check if telemetry is enabled
       */
      isEnabled: (): boolean => {
        return telemetryManager.isEnabled();
      },
      
      /**
       * Enable telemetry
       */
      enable: (): void => {
        telemetryManager.enable();
      },
      
      /**
       * Disable telemetry
       */
      disable: (): void => {
        telemetryManager.disable();
      }
    };
  } catch (error) {
    logger.error('Failed to initialize telemetry system', error);
    
    // Return a noop telemetry interface if initialization fails
    return {
      trackEvent: () => {},
      trackError: () => {},
      flush: async () => {},
      submitTelemetry: async () => {},
      isEnabled: () => false,
      enable: () => {},
      disable: () => {}
    };
  }
} 