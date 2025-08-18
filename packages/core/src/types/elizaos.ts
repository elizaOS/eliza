import type { UUID } from './primitives';
import type { Agent, Character } from './agent';
import type { Plugin } from './plugin';
import type { IAgentRuntime } from './runtime';
import type { IDatabaseAdapter } from './database';
import type { ServiceTypeName, Service } from './service';
import type { RuntimeSettings } from './settings';
import type { ModelTypeName } from './model';

/**
 * Configuration options for ElizaOS initialization
 */
export interface ElizaOSConfig {
  /** Name of the ElizaOS instance */
  name?: string;
  
  /** Global database adapter (can be overridden per agent) */
  databaseAdapter?: IDatabaseAdapter;
  
  /** Global plugins available to all agents */
  globalPlugins?: Plugin[];
  
  /** Default runtime settings for all agents */
  defaultSettings?: RuntimeSettings;
  
  /** Enable debug mode */
  debug?: boolean;
  
  /** Server configuration */
  serverConfig?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    cors?: boolean;
  };
  
  /** Maximum number of concurrent agents */
  maxAgents?: number;
  
  /** Enable clustering for multi-core support */
  clustering?: boolean;
  
  /** Global model providers configuration */
  modelProviders?: {
    [key in ModelTypeName]?: {
      provider: string;
      apiKey?: string;
      config?: Record<string, any>;
    };
  };
}

/**
 * Agent creation options
 */
export interface CreateAgentOptions {
  /** Character configuration for the agent */
  character: Character;
  
  /** Plugins specific to this agent */
  plugins?: Plugin[];
  
  /** Database adapter (overrides global) */
  databaseAdapter?: IDatabaseAdapter;
  
  /** Runtime settings (merged with defaults) */
  settings?: RuntimeSettings;
  
  /** Auto-start the agent after creation */
  autoStart?: boolean;
  
  /** Agent-specific model configuration */
  modelConfig?: Record<string, any>;
}

/**
 * Agent information
 */
export interface AgentInfo {
  /** Agent ID */
  id: UUID;
  
  /** Agent name */
  name: string;
  
  /** Agent status */
  status: 'created' | 'initializing' | 'running' | 'stopped' | 'error';
  
  /** Agent runtime instance */
  runtime: IAgentRuntime;
  
  /** Creation timestamp */
  createdAt: number;
  
  /** Last activity timestamp */
  lastActivity?: number;
  
  /** Error information if status is 'error' */
  error?: Error;
}

/**
 * System status information
 */
export interface SystemStatus {
  /** System uptime in milliseconds */
  uptime: number;
  
  /** Number of active agents */
  activeAgents: number;
  
  /** Total number of agents */
  totalAgents: number;
  
  /** Memory usage */
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  
  /** CPU usage percentage */
  cpuUsage?: number;
  
  /** Registered services */
  services: {
    [key: string]: {
      type: ServiceTypeName;
      status: 'running' | 'stopped' | 'error';
      instances: number;
    };
  };
  
  /** Loaded plugins */
  plugins: {
    name: string;
    version?: string;
    agentCount: number;
  }[];
}

/**
 * Event types emitted by ElizaOS
 */
export enum ElizaOSEventType {
  // System events
  SYSTEM_STARTED = 'SYSTEM_STARTED',
  SYSTEM_STOPPED = 'SYSTEM_STOPPED',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  
  // Agent events
  AGENT_CREATED = 'AGENT_CREATED',
  AGENT_STARTED = 'AGENT_STARTED',
  AGENT_STOPPED = 'AGENT_STOPPED',
  AGENT_ERROR = 'AGENT_ERROR',
  AGENT_REMOVED = 'AGENT_REMOVED',
  
  // Plugin events
  PLUGIN_REGISTERED = 'PLUGIN_REGISTERED',
  PLUGIN_UNREGISTERED = 'PLUGIN_UNREGISTERED',
  
  // Service events
  SERVICE_REGISTERED = 'SERVICE_REGISTERED',
  SERVICE_STARTED = 'SERVICE_STARTED',
  SERVICE_STOPPED = 'SERVICE_STOPPED',
  SERVICE_ERROR = 'SERVICE_ERROR',
}

/**
 * Event payload for ElizaOS events
 */
export interface ElizaOSEvent {
  type: ElizaOSEventType;
  timestamp: number;
  data?: any;
}

/**
 * ElizaOS event handler
 */
export type ElizaOSEventHandler = (event: ElizaOSEvent) => void | Promise<void>;

/**
 * Main ElizaOS interface
 */
export interface IElizaOS {
  /** Unique identifier for this ElizaOS instance */
  readonly id: UUID;
  
  /** Name of this ElizaOS instance */
  readonly name: string;
  
  /** Configuration used to initialize ElizaOS */
  readonly config: ElizaOSConfig;
  
  /** Map of all agents managed by this instance */
  readonly agents: Map<UUID, AgentInfo>;
  
  /** Global plugins available to all agents */
  readonly globalPlugins: Plugin[];
  
  /** Global services */
  readonly services: Map<ServiceTypeName | string, Service[]>;
  
  /** Initialize ElizaOS */
  initialize(): Promise<void>;
  
  /** Start ElizaOS and all auto-start agents */
  start(): Promise<void>;
  
  /** Stop ElizaOS and all agents */
  stop(): Promise<void>;
  
  /** Create a new agent */
  createAgent(options: CreateAgentOptions): Promise<UUID>;
  
  /** Start a specific agent */
  startAgent(agentId: UUID): Promise<void>;
  
  /** Stop a specific agent */
  stopAgent(agentId: UUID): Promise<void>;
  
  /** Remove an agent */
  removeAgent(agentId: UUID): Promise<void>;
  
  /** Get agent by ID */
  getAgent(agentId: UUID): AgentInfo | undefined;
  
  /** Get all agents */
  getAllAgents(): AgentInfo[];
  
  /** Get agents by status */
  getAgentsByStatus(status: AgentInfo['status']): AgentInfo[];
  
  /** Register a global plugin */
  registerGlobalPlugin(plugin: Plugin): Promise<void>;
  
  /** Unregister a global plugin */
  unregisterGlobalPlugin(pluginName: string): Promise<void>;
  
  /** Register a global service */
  registerGlobalService(service: typeof Service): Promise<void>;
  
  /** Unregister a global service */
  unregisterGlobalService(serviceType: ServiceTypeName | string): Promise<void>;
  
  /** Get system status */
  getSystemStatus(): SystemStatus;
  
  /** Subscribe to ElizaOS events */
  on(event: ElizaOSEventType | string, handler: ElizaOSEventHandler): this;
  
  /** Unsubscribe from ElizaOS events */
  off(event: ElizaOSEventType | string, handler: ElizaOSEventHandler): this;
  
  /** Emit an event */
  emit(event: string | symbol, ...args: any[]): boolean;
  
  /** Get or create a shared database adapter */
  getDatabaseAdapter(): IDatabaseAdapter;
  
  /** Execute a function with a specific agent's context */
  withAgent<T>(agentId: UUID, fn: (runtime: IAgentRuntime) => Promise<T>): Promise<T>;
  
  /** Broadcast a message to all agents */
  broadcast(message: any): Promise<void>;
  
  /** Health check */
  healthCheck(): Promise<boolean>;
  
  /** Reset system (stop all agents and clear state) */
  reset(): Promise<void>;
}
