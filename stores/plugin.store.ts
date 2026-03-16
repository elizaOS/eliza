import { Plugin } from './types';

export const pluginStore = {
    plugins: [] as Plugin[],
    
    addPlugin(plugin: Partial<Plugin>) {
        if (this.isValidPlugin(plugin)) {
            this.plugins.push(plugin);
        }
    },

    isValidPlugin(plugin: Partial<Plugin>): plugin is Plugin {
        return typeof plugin === 'object' && plugin !== null && 'id' in plugin;
    },

    getPluginById(id: string): Plugin | undefined {
        return this.plugins.find((plugin) => plugin.id === id);
    },

    removePluginById(id: string): boolean {
        const index = this.plugins.findIndex((plugin) => plugin.id === id);
        if (index > -1) {
            this.plugins.splice(index, 1);
            return true;
        }
        return false;
    }
};

