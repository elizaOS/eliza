import type { Character } from "./agent";
import type { Action, Evaluator, Provider } from "./components";
import type { IDatabaseAdapter } from "./database";
import type { EventHandler, EventPayload, EventPayloadMap } from "./events";
import type { ModelParamsMap, PluginModelResult } from "./model";
import type {
  JsonValue,
  ComponentTypeDefinition as ProtoComponentTypeDefinition,
  JSONSchemaDefinition as ProtoJSONSchemaDefinition,
  PluginManifest as ProtoPluginManifest,
  RouteManifest as ProtoRouteManifest,
} from "./proto.js";
import type { IAgentRuntime } from "./runtime";
import type { Service } from "./service";
import type { TestSuite } from "./testing";

/**
 * Type for a service class constructor.
 * This is more flexible than `typeof Service` to allow for:
 * - Service classes with more specific `serviceType` values (e.g., "task" instead of string)
 * - Service classes that properly extend the base Service class
 */
export interface ServiceClass {
  /** The service type identifier */
  serviceType: string;
  /** Factory method to create and start the service */
  start(runtime: IAgentRuntime): Promise<Service>;
  /** Stop service for a runtime - optional as not all services implement this */
  stopRuntime?(runtime: IAgentRuntime): Promise<void>;
  /** Optional static method to register send handlers */
  registerSendHandlers?(runtime: IAgentRuntime, service: Service): void;
  /** Constructor (optional runtime parameter) */
  new (runtime?: IAgentRuntime): Service;
}

/**
 * Supported types for route request body fields
 */
export type RouteBodyValue = JsonValue;

/**
 * Minimal request interface
 * Plugins can use this type for route handlers
 */
export interface RouteRequest {
  body?: Record<string, RouteBodyValue>;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
  url?: string;
}

/**
 * Minimal response interface
 * Plugins can use this type for route handlers
 */
export interface RouteResponse {
  status: (code: number) => RouteResponse;
  json: (data: unknown) => RouteResponse;
  send: (data: unknown) => RouteResponse;
  end: () => RouteResponse;
  setHeader?: (name: string, value: string | string[]) => RouteResponse;
  sendFile?: (path: string) => RouteResponse;
  headersSent?: boolean;
}

interface BaseRoute {
  type: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "STATIC";
  path: string;
  filePath?: string;
  handler?: (
    req: RouteRequest,
    res: RouteResponse,
    runtime: IAgentRuntime,
  ) => Promise<void>;
  isMultipart?: boolean; // Indicates if the route expects multipart/form-data (file uploads)
}

interface PublicRoute extends BaseRoute {
  public: true;
  name: string; // Name is required for public routes
}

interface PrivateRoute extends BaseRoute {
  public?: false;
  name?: string; // Name is optional for private routes
}

export type Route = PublicRoute | PrivateRoute;

/**
 * JSON Schema type definition for component validation
 */
export type JSONSchemaDefinition = ProtoJSONSchemaDefinition;

/**
 * Component type definition for entity components
 */
export interface ComponentTypeDefinition
  extends Omit<ProtoComponentTypeDefinition, "schema"> {
  schema: JSONSchemaDefinition;
  validator?: (data: Record<string, RouteBodyValue>) => boolean;
}

/**
 * Plugin for extending agent functionality
 */

export type PluginEvents = {
  [K in keyof EventPayloadMap]?: EventHandler<K>[];
};

/** Internal type for runtime event storage - allows dynamic access for event registration */
export type RuntimeEventStorage = PluginEvents & {
  [key: string]:
    | ((
        params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
      ) => Promise<void>)[]
    | undefined;
};

export interface Plugin {
  name: string;
  description: string;

  // Initialize plugin with runtime services
  init?: (
    config: Record<string, string>,
    runtime: IAgentRuntime,
  ) => Promise<void>;

  /** Plugin configuration - string keys to primitive values */
  config?: Record<string, string | number | boolean | null>;

  /**
   * Service classes to be registered with the runtime.
   * Uses ServiceClass interface which is more flexible than `typeof Service`
   * to allow service classes with specific serviceType values.
   */
  services?: ServiceClass[];

  /** Entity component definitions with JSON schema */
  componentTypes?: ComponentTypeDefinition[];

  // Optional plugin features
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  adapter?: IDatabaseAdapter;
  models?: {
    [K in keyof ModelParamsMap]?: (
      runtime: IAgentRuntime,
      params: ModelParamsMap[K],
    ) => Promise<PluginModelResult<K>>;
  };
  events?: PluginEvents;
  routes?: Route[];
  tests?: TestSuite[];

  dependencies?: string[];

  testDependencies?: string[];

  priority?: number;

  schema?: Record<string, JsonValue | object>;
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

export type PluginManifest = ProtoPluginManifest;
export type RouteManifest = ProtoRouteManifest;
