import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { 
  IElizaOS, 
  ElizaOSConfig, 
  CreateAgentOptions, 
  AgentInfo, 
  SystemStatus,
  ElizaOSEventType,
  ElizaOSEvent,
  ElizaOSEventHandler
} from './types/elizaos';
import { UUID } from './types/primitives';
import { Plugin } from './types/plugin';
import { IDatabaseAdapter } from './types/database';
import { ServiceTypeName, Service } from './types/service';
import { IAgentRuntime } from './types/runtime';
import { AgentRuntime } from './runtime';
import { logger } from './logger';

/**
 * Main ElizaOS orchestrator class that manages multiple agents, plugins, and services
 * @example
 * ```typescript
 * const elizaos = new ElizaOS({
 *   name: 'MyElizaOS',
 *   serverConfig: { enabled: true, port: 3000 },
 *   globalPlugins: [corePlugin]
 * });
 * 
 * await elizaos.initialize();
 * await elizaos.start();
 * 
 * // Create and start an agent
 * const agentId = await elizaos.createAgent({
 *   character: myCharacter,
 *   autoStart: true
 * });
 * ```
 */
export class ElizaOS extends EventEmitter implements IElizaOS {
  /** Unique identifier for this ElizaOS instance */
  public readonly id: UUID;
  
  /** Name of this ElizaOS instance */
  public readonly name: string;
  
  /** Configuration used to initialize ElizaOS */
  public readonly config: ElizaOSConfig;
  
  /** Map of all agents managed by this instance */
  public readonly agents: Map<UUID, AgentInfo> = new Map<UUID, AgentInfo>();
  
  /** Global plugins available to all agents */
  public readonly globalPlugins: Plugin[] = [];
  
  /** Global services */
  public readonly services: Map<ServiceTypeName | string, Service[]> = new Map<ServiceTypeName | string, Service[]>();
  
  /** Private fields */
  private isInitialized = false;
  private isStarted = false;
  private startTime?: number;
  private databaseAdapter?: IDatabaseAdapter;
  private eventHandlers: Map<string, Set<ElizaOSEventHandler>> = new Map<string, Set<ElizaOSEventHandler>>();
  
  constructor(config: ElizaOSConfig = {}) {
    super();
    
    // Generate unique ID for this instance
    this.id = uuidv4() as UUID;
    
    // Set name
    this.name = config.name || 'ElizaOS-' + this.id.slice(0, 8);
    
    // Store configuration with defaults
    this.config = {
      maxAgents: 100,
      debug: false,
      clustering: false,
      serverConfig: {
        enabled: false,
        port: 3000,
        host: 'localhost',
        cors: true,
      },
      ...config,
    };
    
    // Set global plugins
    if (config.globalPlugins) {
      this.globalPlugins.push(...config.globalPlugins);
    }
    
    // Set database adapter
    this.databaseAdapter = config.databaseAdapter;
    
    // Enable debug logging if configured
    if (this.config.debug) {
      logger.info(`ElizaOS instance created: ${this.name} (${this.id})`);
    }
  }
  
  /**
   * Initialize ElizaOS
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('ElizaOS already initialized');
      return;
    }
    
    logger.info(`Initializing ElizaOS: ${this.name}`);
    
    try {
      // Initialize database adapter if provided
      if (this.databaseAdapter) {
        try {
          await this.databaseAdapter.initialize();
          logger.info('Database adapter initialized');
        } catch (dbError) {
          logger.error('Failed to initialize database adapter');
          logger.error(dbError as Error);
          // Reset database adapter on failure
          this.databaseAdapter = undefined;
          // Continue initialization without database
          logger.warn('Continuing without database adapter');
        }
      }
      
      // Initialize global plugins
      for (const plugin of this.globalPlugins) {
        if (plugin.init) {
          // Create a minimal runtime context for plugin initialization
          const minimalRuntime = {
            getSetting: (key: string) => this.config.defaultSettings?.[key],
            logger,
          } as any;
          
          await plugin.init(plugin.config || {}, minimalRuntime);
          logger.info(`Initialized global plugin: ${plugin.name}`);
        }
      }
      
      this.isInitialized = true;
      this.emit(ElizaOSEventType.SYSTEM_STARTED, { name: this.name, id: this.id });
      
      logger.info('ElizaOS initialization complete');
    } catch (error) {
      logger.error('Failed to initialize ElizaOS');  
      logger.error(error as Error);
      this.emit(ElizaOSEventType.SYSTEM_ERROR, { error });
      throw error;
    }
  }
  
  /**
   * Start ElizaOS and all auto-start agents
   */
  async start(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    if (this.isStarted) {
      logger.warn('ElizaOS already started');
      return;
    }
    
    logger.info(`Starting ElizaOS: ${this.name}`);
    
    try {
      this.startTime = Date.now();
      
      // Start all agents that are in 'created' state
      const agentsToStart = Array.from(this.agents.values()).filter(
        agent => agent.status === 'created'
      );
      
      for (const agent of agentsToStart) {
        try {
          await this.startAgent(agent.id);
        } catch (error) {
          logger.error(`Failed to start agent ${agent.name}`);  
          logger.error(error as Error);
        }
      }
      
      this.isStarted = true;
      logger.info('ElizaOS started successfully');
    } catch (error) {
      logger.error('Failed to start ElizaOS');  
      logger.error(error as Error);
      this.emit(ElizaOSEventType.SYSTEM_ERROR, { error });
      throw error;
    }
  }
  
  /**
   * Stop ElizaOS and all agents
   */
  async stop(): Promise<void> {
    if (!this.isStarted) {
      logger.warn('ElizaOS not started');
      return;
    }
    
    logger.info(`Stopping ElizaOS: ${this.name}`);
    
    try {
      // Stop all running agents
      const runningAgents = Array.from(this.agents.values()).filter(
        agent => agent.status === 'running'
      );
      
      for (const agent of runningAgents) {
        try {
          await this.stopAgent(agent.id);
        } catch (error) {
          logger.error(`Failed to stop agent ${agent.name}`);  
          logger.error(error as Error);
        }
      }
      
      // Stop global services
      for (const [serviceType, serviceList] of this.services) {
        for (const service of serviceList) {
          try {
            await service.stop();
            logger.info(`Stopped service: ${serviceType}`);
          } catch (error) {
            logger.error(`Failed to stop service ${serviceType}`);  
            logger.error(error as Error);
          }
        }
      }
      
      // Close database connection
      if (this.databaseAdapter) {
        await this.databaseAdapter.close();
      }
      
      this.isStarted = false;
      this.emit(ElizaOSEventType.SYSTEM_STOPPED, { name: this.name });
      
      logger.info('ElizaOS stopped successfully');
    } catch (error) {
      logger.error('Failed to stop ElizaOS');  
      logger.error(error as Error);
      this.emit(ElizaOSEventType.SYSTEM_ERROR, { error });
      throw error;
    }
  }
  
  /**
   * Create a new agent
   */
  async createAgent(options: CreateAgentOptions): Promise<UUID> {
    if (!this.isInitialized) {
      throw new Error('ElizaOS not initialized');
    }
    
    // Check max agents limit
    if (this.agents.size >= (this.config.maxAgents || 100)) {
      throw new Error(`Maximum number of agents (${this.config.maxAgents}) reached`);
    }
    
    const agentId = options.character.id || (uuidv4() as UUID);
    
    logger.info(`Creating agent: ${options.character.name} (${agentId})`);
    
    try {
      // Merge settings
      const settings = {
        ...this.config.defaultSettings,
        ...options.settings,
      };
      
      // Combine global and agent-specific plugins
      const plugins = [...this.globalPlugins, ...(options.plugins || [])];
      
      // Create runtime
      const runtime = new AgentRuntime({
        agentId: agentId as UUID,
        character: options.character,
        plugins,
        adapter: options.databaseAdapter || this.databaseAdapter,
        settings,
      });
      
      // Create agent info
      const agentInfo: AgentInfo = {
        id: agentId as UUID,
        name: options.character.name,
        status: 'created',
        runtime,
        createdAt: Date.now(),
      };
      
      // Store agent
      this.agents.set(agentId as UUID, agentInfo);
      
      // Emit event
      this.emit(ElizaOSEventType.AGENT_CREATED, { 
        agentId, 
        name: options.character.name 
      });
      
      // Auto-start if configured
      if (options.autoStart) {
        await this.startAgent(agentId as UUID);
      }
      
      logger.info(`Agent created: ${options.character.name} (${agentId})`);
      
      return agentId as UUID;
    } catch (error) {
      logger.error(`Failed to create agent ${options.character.name}`);  
      logger.error(error as Error);
      
      // Clean up on failure
      this.agents.delete(agentId as UUID);
      
      this.emit(ElizaOSEventType.AGENT_ERROR, { 
        agentId, 
        error 
      });
      
      throw error;
    }
  }
  
  /**
   * Start a specific agent
   */
  async startAgent(agentId: UUID): Promise<void> {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    
    if (agent.status === 'running') {
      logger.warn(`Agent already running: ${agent.name}`);
      return;
    }
    
    logger.info(`Starting agent: ${agent.name} (${agentId})`);
    
    try {
      // Update status
      agent.status = 'initializing';
      
      // Initialize runtime
      await agent.runtime.initialize();
      
      // Update status
      agent.status = 'running';
      agent.lastActivity = Date.now();
      
      // Emit event
      this.emit(ElizaOSEventType.AGENT_STARTED, { 
        agentId, 
        name: agent.name 
      });
      
      logger.info(`Agent started: ${agent.name} (${agentId})`);
    } catch (error) {
      logger.error(`Failed to start agent ${agent.name}`);  
      logger.error(error as Error);
      
      agent.status = 'error';
      agent.error = error as Error;
      
      this.emit(ElizaOSEventType.AGENT_ERROR, { 
        agentId, 
        error 
      });
      
      throw error;
    }
  }
  
  /**
   * Stop a specific agent
   */
  async stopAgent(agentId: UUID): Promise<void> {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    
    if (agent.status === 'stopped') {
      logger.warn(`Agent already stopped: ${agent.name}`);
      return;
    }
    
    logger.info(`Stopping agent: ${agent.name} (${agentId})`);
    
    try {
      // Stop runtime
      await agent.runtime.stop();
      
      // Update status
      agent.status = 'stopped';
      agent.lastActivity = Date.now();
      
      // Emit event
      this.emit(ElizaOSEventType.AGENT_STOPPED, { 
        agentId, 
        name: agent.name 
      });
      
      logger.info(`Agent stopped: ${agent.name} (${agentId})`);
    } catch (error) {
      logger.error(`Failed to stop agent ${agent.name}`);  
      logger.error(error as Error);
      
      agent.status = 'error';
      agent.error = error as Error;
      
      this.emit(ElizaOSEventType.AGENT_ERROR, { 
        agentId, 
        error 
      });
      
      throw error;
    }
  }
  
  /**
   * Remove an agent
   */
  async removeAgent(agentId: UUID): Promise<void> {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    
    logger.info(`Removing agent: ${agent.name} (${agentId})`);
    
    try {
      // Stop agent if running
      if (agent.status === 'running') {
        await this.stopAgent(agentId);
      }
      
      // Remove from map
      this.agents.delete(agentId);
      
      // Emit event
      this.emit(ElizaOSEventType.AGENT_REMOVED, { 
        agentId, 
        name: agent.name 
      });
      
      logger.info(`Agent removed: ${agent.name} (${agentId})`);
    } catch (error) {
      logger.error(`Failed to remove agent ${agent.name}`);  
      logger.error(error as Error);
      throw error;
    }
  }
  
  /**
   * Get agent by ID
   */
  getAgent(agentId: UUID): AgentInfo | undefined {
    return this.agents.get(agentId);
  }
  
  /**
   * Get all agents
   */
  getAllAgents(): AgentInfo[] {
    return Array.from(this.agents.values());
  }
  
  /**
   * Get agents by status
   */
  getAgentsByStatus(status: AgentInfo['status']): AgentInfo[] {
    return Array.from(this.agents.values()).filter(agent => agent.status === status);
  }
  
  /**
   * Register a global plugin
   */
  async registerGlobalPlugin(plugin: Plugin): Promise<void> {
    logger.info(`Registering global plugin: ${plugin.name}`);
    
    try {
      // Initialize plugin if needed
      if (plugin.init && this.isInitialized) {
        const minimalRuntime = {
          getSetting: (key: string) => this.config.defaultSettings?.[key],
          logger,
        } as any;
        
        await plugin.init(plugin.config || {}, minimalRuntime);
      }
      
      // Add to global plugins
      this.globalPlugins.push(plugin);
      
      // Add to all existing agents
      for (const agent of this.agents.values()) {
        await agent.runtime.registerPlugin(plugin);
      }
      
      // Emit event
      this.emit(ElizaOSEventType.PLUGIN_REGISTERED, { 
        pluginName: plugin.name 
      });
      
      logger.info(`Global plugin registered: ${plugin.name}`);
    } catch (error) {
      logger.error(`Failed to register global plugin ${plugin.name}`);  
      logger.error(error as Error);
      throw error;
    }
  }
  
  /**
   * Unregister a global plugin
   */
  async unregisterGlobalPlugin(pluginName: string): Promise<void> {
    logger.info(`Unregistering global plugin: ${pluginName}`);
    
    try {
      // Find and remove plugin
      const index = this.globalPlugins.findIndex(p => p.name === pluginName);
      
      if (index === -1) {
        throw new Error(`Plugin not found: ${pluginName}`);
      }
      
      this.globalPlugins.splice(index, 1);
      
      // Note: Cannot remove from existing agents as they may depend on it
      logger.warn(`Plugin ${pluginName} removed from global list but remains in existing agents`);
      
      // Emit event
      this.emit(ElizaOSEventType.PLUGIN_UNREGISTERED, { 
        pluginName 
      });
      
      logger.info(`Global plugin unregistered: ${pluginName}`);
    } catch (error) {
      logger.error(`Failed to unregister global plugin ${pluginName}`);  
      logger.error(error as Error);
      throw error;
    }
  }
  
  /**
   * Register a global service
   */
  async registerGlobalService(ServiceClass: typeof Service): Promise<void> {
    const serviceType = ServiceClass.serviceType as ServiceTypeName;
    
    logger.info(`Registering global service: ${serviceType}`);
    
    try {
      // Create minimal runtime for service
      const minimalRuntime = {
        getSetting: (key: string) => this.config.defaultSettings?.[key],
        logger,
      } as any;
      
      // Start service
      const service = await ServiceClass.start(minimalRuntime);
      
      // Store service
      if (!this.services.has(serviceType)) {
        this.services.set(serviceType, []);
      }
      this.services.get(serviceType)!.push(service);
      
      // Emit event
      this.emit(ElizaOSEventType.SERVICE_REGISTERED, { 
        serviceType 
      });
      
      logger.info(`Global service registered: ${serviceType}`);
    } catch (error) {
      logger.error(`Failed to register global service ${serviceType}`);  
      logger.error(error as Error);
      
      this.emit(ElizaOSEventType.SERVICE_ERROR, { 
        serviceType, 
        error 
      });
      
      throw error;
    }
  }
  
  /**
   * Unregister a global service
   */
  async unregisterGlobalService(serviceType: ServiceTypeName | string): Promise<void> {
    logger.info(`Unregistering global service: ${serviceType}`);
    
    try {
      const services = this.services.get(serviceType);
      
      if (!services || services.length === 0) {
        throw new Error(`No services found for type: ${serviceType}`);
      }
      
      // Stop all services of this type
      for (const service of services) {
        try {
          await service.stop();
          logger.info(`Stopped service instance of type: ${serviceType}`);
        } catch (error) {
          logger.error(`Failed to stop service ${serviceType}`);  
          logger.error(error as Error);
        }
      }
      
      // Remove from map
      this.services.delete(serviceType);
      
      logger.info(`Global service unregistered: ${serviceType}`);
    } catch (error) {
      logger.error(`Failed to unregister global service ${serviceType}`);  
      logger.error(error as Error);
      throw error;
    }
  }
  
  /**
   * Get system status
   */
  getSystemStatus(): SystemStatus {
    const memUsage = process.memoryUsage();
    
    // Count agents by status
    const activeAgents = this.getAgentsByStatus('running').length;
    
    // Gather service info
    const services: SystemStatus['services'] = {};
    for (const [type, serviceList] of this.services) {
      services[type] = {
        type: type as ServiceTypeName,
        status: 'running', // Simplified - would need per-service status tracking
        instances: serviceList.length,
      };
    }
    
    // Gather plugin info
    const pluginUsage = new Map<string, number>();
    for (const agent of this.agents.values()) {
      for (const plugin of agent.runtime.plugins) {
        pluginUsage.set(plugin.name, (pluginUsage.get(plugin.name) || 0) + 1);
      }
    }
    
    const plugins = this.globalPlugins.map(plugin => ({
      name: plugin.name,
      agentCount: pluginUsage.get(plugin.name) || 0,
    }));
    
    return {
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      activeAgents,
      totalAgents: this.agents.size,
      memoryUsage: {
        rss: memUsage.rss,
        heapTotal: memUsage.heapTotal,
        heapUsed: memUsage.heapUsed,
        external: memUsage.external,
      },
      services,
      plugins,
    };
  }
  
  /**
   * Subscribe to ElizaOS events
   */
  on(event: ElizaOSEventType | string, handler: ElizaOSEventHandler): this {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    
    // Don't duplicate in EventEmitter to avoid memory leaks
    return this;
  }
  
  /**
   * Unsubscribe from ElizaOS events
   */
  off(event: ElizaOSEventType | string, handler: ElizaOSEventHandler): this {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      // Remove the set if empty to prevent memory leak
      if (handlers.size === 0) {
        this.eventHandlers.delete(event);
      }
    }
    
    return this;
  }
  
  /**
   * Override emit to handle ElizaOS events properly
   * @override
   */
  emit(event: string | symbol, ...args: any[]): boolean {
    // If it's our ElizaOS event, handle it specially
    if (typeof event === 'string' && Object.values(ElizaOSEventType).includes(event as ElizaOSEventType)) {
      const data = args[0];
      const elizaEvent: ElizaOSEvent = {
        type: event as ElizaOSEventType,
        timestamp: Date.now(),
        data,
      };
      
      // Emit through our handlers
      const handlers = this.eventHandlers.get(event);
      if (handlers && handlers.size > 0) {
        for (const handler of handlers) {
          try {
            const result = handler(elizaEvent);
            if (result instanceof Promise) {
              result.catch(error => {
                logger.error(`Event handler error for ${event}`);  
              logger.error(error as Error);
              });
            }
          } catch (error) {
            logger.error(`Event handler error for ${event}`);  
            logger.error(error as Error);
          }
        }
        return true;
      }
      return false;
    }
    
    // For non-ElizaOS events, use EventEmitter
    return super.emit(event, ...args);
  }
  
  /**
   * Get or create a shared database adapter
   */
  getDatabaseAdapter(): IDatabaseAdapter {
    if (!this.databaseAdapter) {
      throw new Error('No database adapter configured');
    }
    return this.databaseAdapter;
  }
  
  /**
   * Execute a function with a specific agent's context
   */
  async withAgent<T>(agentId: UUID, fn: (runtime: IAgentRuntime) => Promise<T>): Promise<T> {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    
    if (agent.status !== 'running') {
      throw new Error(`Agent not running: ${agent.name}`);
    }
    
    try {
      // Update last activity
      agent.lastActivity = Date.now();
      
      // Execute function with agent's runtime
      return await fn(agent.runtime);
    } catch (error) {
      logger.error(`Error executing with agent ${agent.name}`);  
      logger.error(error as Error);
      throw error;
    }
  }
  
  /**
   * Broadcast a message to all agents
   */
  async broadcast(_message: any): Promise<void> {
    logger.info('Broadcasting message to all agents');
    
    const runningAgents = this.getAgentsByStatus('running');
    const results = await Promise.allSettled(
      runningAgents.map(async agent => {
        try {
          // This would need proper message handling implementation
          // For now, just log
          logger.info(`Broadcasting to agent ${agent.name}`);
          // await agent.runtime.processMessage(message);
        } catch (error) {
          logger.error(`Failed to broadcast to agent ${agent.name}`);  
          logger.error(error as Error);
          throw error;
        }
      })
    );
    
    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(`Broadcast failed for agent ${runningAgents[index].name}`);  
        logger.error(result.reason as Error);
      }
    });
  }
  
  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Check database connection
      if (this.databaseAdapter) {
        const dbReady = await this.databaseAdapter.isReady();
        if (!dbReady) {
          logger.warn('Database not ready');
          return false;
        }
      }
      
      // Check if we have at least one running agent
      const runningAgents = this.getAgentsByStatus('running');
      if (runningAgents.length === 0 && this.agents.size > 0) {
        logger.warn('No running agents');
        return false;
      }
      
      // Check services
      for (const [serviceType, serviceList] of this.services) {
        if (serviceList.length === 0) {
          logger.warn(`No instances of service ${serviceType}`);
        }
      }
      
      return true;
    } catch (error) {
      logger.error('Health check failed');  
      logger.error(error as Error);
      return false;
    }
  }
  
  /**
   * Reset system (stop all agents and clear state)
   */
  async reset(): Promise<void> {
    logger.info('Resetting ElizaOS');
    
    try {
      // Stop system
      if (this.isStarted) {
        await this.stop();
      }
      
      // Clear all agents
      this.agents.clear();
      
      // Clear services
      this.services.clear();
      
      // Clear event handlers
      this.eventHandlers.clear();
      this.removeAllListeners();
      
      // Reset state
      this.isInitialized = false;
      this.isStarted = false;
      this.startTime = undefined;
      
      logger.info('ElizaOS reset complete');
    } catch (error) {
      logger.error('Failed to reset ElizaOS');  
      logger.error(error as Error);
      throw error;
    }
  }
}
