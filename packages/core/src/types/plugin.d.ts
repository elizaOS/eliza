import type { Character } from './agent';
import type { Action, Evaluator, Provider } from './components';
import type { IDatabaseAdapter } from './database';
import type { EventHandler, EventPayloadMap } from './events';
import type { IAgentRuntime } from './runtime';
import type { Service } from './service';
import type { TestSuite } from './testing';
export type Route = {
    type: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'STATIC';
    path: string;
    filePath?: string;
    public?: boolean;
    name?: string extends {
        public: true;
    } ? string : string | undefined;
    handler?: (req: any, res: any, runtime: IAgentRuntime) => Promise<void>;
    isMultipart?: boolean;
};
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
    init?: (config: Record<string, string>, runtime: IAgentRuntime) => Promise<void>;
    config?: {
        [key: string]: any;
    };
    services?: (typeof Service)[];
    componentTypes?: {
        name: string;
        schema: Record<string, unknown>;
        validator?: (data: any) => boolean;
    }[];
    actions?: Action[];
    providers?: Provider[];
    evaluators?: Evaluator[];
    adapter?: IDatabaseAdapter;
    models?: {
        [key: string]: (...args: any[]) => Promise<any>;
    };
    events?: PluginEvents;
    routes?: Route[];
    tests?: TestSuite[];
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
//# sourceMappingURL=plugin.d.ts.map