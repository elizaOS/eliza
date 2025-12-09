import type { Character } from './agent';
import type { Action, Evaluator, Provider } from './components';
import type { IDatabaseAdapter } from './database';
import type { EventHandler, EventPayloadMap, EventPayload } from './events';
import type { ModelHandler, ModelParamsMap, ModelResultMap, ModelTypeName } from './model';
import type { IAgentRuntime } from './runtime';
import type { Service } from './service';
import type { TestSuite } from './testing';

export interface RouteRequest {
  [key: string]: unknown;
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
}

export interface RouteResponse {
  [key: string]: unknown;
  status?: (code: number) => RouteResponse;
  json?: (data: unknown) => void;
  send?: (data: unknown) => void;
  end?: () => void;
}

export type Route = {
  type: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'STATIC';
  path: string;
  filePath?: string;
  public?: boolean;
  name?: string extends { public: true } ? string : string | undefined;
  handler?: (req: RouteRequest, res: RouteResponse, runtime: IAgentRuntime) => Promise<void>;
  isMultipart?: boolean; // Indicates if the route expects multipart/form-data (file uploads)
};

/**
 * Plugin for extending agent functionality
 */

export type PluginEvents = {
  [K in keyof EventPayloadMap]?: EventHandler<K>[];
} & {
  [key: string]: ((params: EventPayload) => Promise<void>)[];
};

export interface Plugin {
  name: string;
  description: string;

  // Initialize plugin with runtime services
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;

  // Configuration
  config?: { [key: string]: string | number | boolean | null | undefined };

  services?: (typeof Service)[];

  // Entity component definitions
  componentTypes?: {
    name: string;
    schema: Record<string, unknown>;
    validator?: (data: unknown) => boolean;
  }[];

  // Optional plugin features
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  adapter?: IDatabaseAdapter;
  models?: {
    [K in ModelTypeName]?: ModelHandler<ModelParamsMap[K], ModelResultMap[K]>['handler'];
  } & {
    [key: string]: ModelHandler<Record<string, unknown>, unknown>['handler'];
  };
  events?: PluginEvents;
  routes?: Route[];
  tests?: TestSuite[];

  dependencies?: string[];

  testDependencies?: string[];

  priority?: number;

  schema?: Record<string, unknown>;
}

export interface ProjectAgent {
  character: Character;
  init?: (runtime: IAgentRuntime) => Promise<void>;
  plugins?: Plugin[];
  tests?: TestSuite | TestSuite[];
}

export interface Project {
  agents: ProjectAgent[];
}
