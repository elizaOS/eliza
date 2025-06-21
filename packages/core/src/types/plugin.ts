import type { Character } from './agent';
import type { Action, Evaluator, Provider } from './components';
import type { IDatabaseAdapter } from './database';
import type { EventHandler, EventPayloadMap } from './events';
import type { IAgentRuntime } from './runtime';
import type { Service } from './service';
import type { TestSuite } from './testing';
import type { ComponentConfig } from './plugin-config';
import type { PluginScenario } from './scenario';

export type Route = {
  type: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'STATIC';
  path: string;
  filePath?: string;
  public?: boolean;
  name?: string extends { public: true } ? string : string | undefined;
  handler?: (req: any, res: any, runtime: IAgentRuntime) => Promise<void>;
  isMultipart?: boolean; // Indicates if the route expects multipart/form-data (file uploads)
};

/**
 * Component dependency for validation
 */
export interface ComponentDependency {
  type: 'action' | 'provider' | 'evaluator' | 'service';
  name: string;
  optional?: boolean;
  pluginName?: string; // For cross-plugin dependencies
  required?: boolean; // Whether this dependency is required
  components?: string[]; // Specific components required from the plugin
}

/**
 * Enhanced component configuration with dependencies
 */
export interface EnhancedComponentConfig extends ComponentConfig {
  /** Whether component is enabled by default */
  defaultEnabled: boolean;
  
  /** Mark as legacy component (from non-configurable arrays) */
  legacy?: boolean;
  
  /** Component dependencies */
  dependencies?: ComponentDependency[];
}

/**
 * Unified component definition for new configurable system
 */
export interface ComponentDefinition {
  type: 'action' | 'provider' | 'evaluator' | 'service';
  name?: string; // Optional override of component.name
  component: Action | Provider | Evaluator | typeof Service;
  config?: EnhancedComponentConfig;
}

/**
 * Plugin for extending agent functionality
 */

export type PluginEvents = {
  [K in keyof EventPayloadMap]?: EventHandler<K>[];
} & {
  [key: string]: ((params: any) => Promise<any>)[];
};

export interface Plugin {
  name: string;
  description: string;

  // Initialize plugin with runtime services
  init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;

  // Configuration
  config?: { 
    defaultEnabled?: boolean;
    category?: string;
    permissions?: string[];
    [key: string]: any;
  };

  services?: (typeof Service)[];

  // Entity component definitions
  componentTypes?: {
    name: string;
    schema: Record<string, unknown>;
    validator?: (data: any) => boolean;
  }[];

  // Legacy plugin features (always enabled for backwards compatibility)
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  
  // New configurable components (can be enabled/disabled)
  components?: ComponentDefinition[];
  
  adapter?: IDatabaseAdapter;
  models?: {
    [key: string]: (...args: any[]) => Promise<any>;
  };
  events?: PluginEvents;
  routes?: Route[];
  tests?: TestSuite[];
  scenarios?: PluginScenario[];

  dependencies?: string[];

  testDependencies?: string[];

  priority?: number;

  schema?: any;
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
