declare module "@elizaos/core" {
  export type ActionResult = any;
  export type Agent = any;
  export type Character = Record<string, any>;
  export type ChannelType = string;
  export type Component = any;
  export type Content = any;
  export type ContentType = string;
  export type Entity = any;
  export type HandlerCallback = (...args: any[]) => any;
  export type IAgentRuntime = Record<string, any>;
  export type Log = any;
  export type LogEntry = any;
  export type Media = any;
  export type Memory = any;
  export type ModelType = string;
  export type PluginInstallRecord = any;
  export type ProviderResult = any;
  export type Relationship = any;
  export type Room = any;
  export type State = any;
  export type TargetInfo = any;
  export type Task = any;
  export type UUID = string;
  export type World = any;
  export type SessionConfig = any;
  export type SessionSendPolicyConfig = any;
  export type BlockStreamingChunkConfig = any;
  export type BlockStreamingCoalesceConfig = any;
  export type HumanDelayConfig = any;
  export type TypingMode = any;
  export type GroupChatConfig = any;
  export type IdentityConfig = any;
  export type NativeCommandsSetting = any;
  export type AgentElevatedAllowFromConfig = any;
  export type NormalizedChatType = any;
  export type SessionSendPolicyAction = any;
  export type ToolPolicyConfig = any;
  export type ToolProfileId = any;
  export type ServiceClass = any;
  export type ServiceTypeName = string;
  export const AgentEventService: any;
  export const AutonomyService: any;
  export const logger: {
    debug: (...args: any[]) => void;
    error: (...args: any[]) => void;
    info: (...args: any[]) => void;
    log: (...args: any[]) => void;
    warn: (...args: any[]) => void;
  };
  export const ChannelType: {
    [key: string]: string;
    DM: string;
    GROUP: string;
    SELF: string;
  };
  export const ContentType: Record<string, string>;
  export const ModelType: {
    [key: string]: string;
    IMAGE: string;
    TEXT_EMBEDDING: string;
    TEXT_LARGE: string;
    TEXT_SMALL: string;
  };

  export class AgentRuntime {
    constructor(...args: any[]);
    adapter: any;
    agentId: string;
    character: any;
    getCache: <T = any>(...args: any[]) => Promise<T>;
    getRoom: <T = any>(...args: any[]) => T;
    getService: <T = any>(type: string) => T;
    setCache: <T = any>(...args: any[]) => Promise<T>;
    updateAgent: (...args: any[]) => any;
    [key: string]: any;
  }

  export class Service {
    constructor(...args: any[]);
    [key: string]: any;
  }

  export interface Action {
    description?: string;
    examples?: any[];
    handler?: (...args: any[]) => any;
    name: string;
    parameters?: any[];
    similes?: string[];
    validate?: (...args: any[]) => any;
  }

  export interface Provider {
    description?: string;
    dynamic?: boolean;
    get?: (...args: any[]) => any;
    name?: string;
    position?: any;
    alwaysRun?: boolean;
    relevanceKeywords?: string[];
  }

  export interface Plugin {
    actions?: Action[];
    description?: string;
    init?: (...args: any[]) => any;
    name?: string;
    priority?: number;
    providers?: Provider[];
    services?: any[];
  }

  export interface HandlerOptions {
    parameters?: Record<string, any>;
  }

  export function addLogListener(...args: any[]): any;
  export function createMessageMemory(...args: any[]): any;
  export function mergeCharacterDefaults(...args: any[]): any;
  export function stringToUuid(value: string): any;
}
