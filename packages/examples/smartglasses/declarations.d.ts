declare module "pngjs" {
  export class PNG {
    width: number;
    height: number;
    data: Uint8Array;
    static sync: {
      read(buffer: Buffer): PNG;
    };
  }
}

declare module "@elizaos/core" {
  export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };
  export type ActionResult = {
    success?: boolean;
    text?: string;
    values?: Record<string, unknown>;
  };
  export type HandlerCallback = (response: { text?: string }) => Promise<void>;
  export type HandlerOptions = Record<string, unknown>;
  export type Memory = { content?: { text?: string } };
  export type State = Record<string, unknown>;
  export type Action = {
    name: string;
    handler: (...args: unknown[]) => Promise<ActionResult> | ActionResult;
    validate?: (...args: unknown[]) => Promise<boolean> | boolean;
    [key: string]: unknown;
  };
  export type Provider = {
    name: string;
    get: (
      runtime: IAgentRuntime,
      ...args: unknown[]
    ) => Promise<{ text?: string }> | { text?: string };
    [key: string]: unknown;
  };
  export type Plugin = {
    name?: string;
    actions?: Action[];
    providers?: Provider[];
    services?: ServiceClass[];
    [key: string]: unknown;
  };
  export type ServiceClass = {
    serviceType?: string;
    start?: (runtime: IAgentRuntime) => Promise<Service>;
    new (runtime?: IAgentRuntime): Service;
  };
  export interface IAgentRuntime {
    actions: Action[];
    providers: Provider[];
    getService<T>(name: string): T | null;
    getSetting?(name: string): unknown;
    emitEvent?(event: string, payload: Record<string, unknown>): Promise<void>;
  }

  export const logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };

  export class Service {
    static serviceType?: string;
    runtime?: IAgentRuntime;
    constructor(runtime?: IAgentRuntime);
    stop?(): Promise<void>;
  }

  export class AgentRuntime implements IAgentRuntime {
    actions: Action[];
    character: { name?: string };
    providers: Provider[];
    constructor(options: Record<string, unknown>);
    initialize(options?: Record<string, unknown>): Promise<void>;
    stop?(): Promise<void>;
    getService<T>(name: string): T | null;
    getSetting(name: string): unknown;
    emitEvent(event: string, payload: Record<string, unknown>): Promise<void>;
  }

  export function createCharacter(config: Record<string, unknown>): unknown;
  export function parseJSONObjectFromText(text: string): unknown;
}

declare module "@elizaos/ui/app-shell-registry" {
  export function registerAppShellPage(page: Record<string, unknown>): void;
}
