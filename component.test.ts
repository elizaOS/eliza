import { describe, it } from 'vitest';
import { pluginStore } from '../stores/plugin.store';

describe('Plugin Store', () => {
    it('adds a plugin correctly', () => {
        const plugin = { id: 'testPlugin' };
        pluginStore.addPlugin(plugin);
        expect(pluginStore.getPluginById('testPlugin')).toEqual(plugin);
    });
    
    it('does not add invalid plugins', () => {
        // Attempt to add invalid plugin
        const invalidPlugin = { name: 'invalid' };
        pluginStore.addPlugin(invalidPlugin);
        expect(pluginStore.getPluginById('invalid')).toBeUndefined();
    });
});
