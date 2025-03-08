export type Plugin = {
	name: string;
	description?: string;
	providers?: Provider[];
	actions?: Action[];
	models?: ModelHandlerMap;
	routes?: Route[];
	events?: PluginEventMap;
	staticDirs?: StaticDir[];
	init?: (config?: any, runtime?: IAgentRuntime) => Promise<void> | void;
};

export interface StaticDir {
	path: string;
	mountPath?: string;
	pluginName?: string;
}
