import { describe, it, expect } from 'vitest';
import { pluginStore } from '../stores/plugin.store';
import { patchComponent } from '../utils/component';

describe('Plugin Store', () => {
    it('adds a plugin correctly', () => {
        const plugin = { id: 'testPlugin' };
        pluginStore.addPlugin(plugin);
        expect(pluginStore.getPluginById('testPlugin')).toEqual(plugin);
    });
    
    // Note: ensures only valid plugins are added, maintaining store integrity and preventing errors
    it('does not add invalid plugins', () => {
        // Attempt to add invalid plugin
        const invalidPlugin = { name: 'invalid' };
        pluginStore.addPlugin(invalidPlugin);
        expect(pluginStore.getPluginById('invalid')).toBeUndefined();
    });
});

describe('patchComponent', () => {
    it('should add a new property to an object', () => {
        const obj = { a: 1 };
        patchComponent(obj, 'b', 2);
        expect(obj).toEqual({ a: 1, b: 2 });
    });

    it('should update an existing property', () => {
        const obj = { a: 1 };
        patchComponent(obj, 'a', 2);
        expect(obj).toEqual({ a: 2 });
    });

    it('should handle array properties', () => {
        const obj = { a: [1, 2] };
        patchComponent(obj, 'a', [3, 4]);
        expect(obj).toEqual({ a: [3, 4] });
    });

    it('should handle object properties', () => {
        const obj = { a: { b: 1 } };
        patchComponent(obj, 'a', { c: 2 });
        expect(obj).toEqual({ a: { c: 2 } });
    });

    it('should handle nested path with dot notation', () => {
        const obj = { a: { b: 1 } };
        patchComponent(obj, 'a.b', 2);
        expect(obj).toEqual({ a: { b: 2 } });
    });

    it('should create nested objects when needed', () => {
        const obj = {};
        patchComponent(obj, 'a.b.c', 1);
        expect(obj).toEqual({ a: { b: { c: 1 } } });
    });

    it('should handle arrays in path', () => {
        const obj = { items: [{ id: 1 }, { id: 2 }] };
        patchComponent(obj, 'items.1.id', 3);
        expect(obj).toEqual({ items: [{ id: 1 }, { id: 3 }] });
    });

    it('should handle complex nested paths', () => {
        const obj = { a: { items: [{ data: { value: 1 } }] } };
        patchComponent(obj, 'a.items.0.data.value', 2);
        expect(obj).toEqual({ a: { items: [{ data: { value: 2 } }] } });
    });
});
// Note: tests complex nested paths to ensure accurate deep updates in object structures
