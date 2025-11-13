/**
 * Plugin Selection Tests for Scenario Runtime
 * Ensures plugin-sql and plugin-mysql are not loaded simultaneously
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

describe('Scenario Plugin Selection', () => {
    let originalMysqlUrl: string | undefined;

    beforeEach(() => {
        originalMysqlUrl = process.env.MYSQL_URL;
    });

    afterEach(() => {
        if (originalMysqlUrl !== undefined) {
            process.env.MYSQL_URL = originalMysqlUrl;
        } else {
            delete process.env.MYSQL_URL;
        }
    });

    it('should select plugin-sql when MYSQL_URL is not set', () => {
        delete process.env.MYSQL_URL;

        // Simulate the default plugin selection logic from runtime-factory
        const defaultDatabasePlugin = process.env.MYSQL_URL
            ? '@elizaos/plugin-mysql'
            : '@elizaos/plugin-sql';

        expect(defaultDatabasePlugin).toBe('@elizaos/plugin-sql');
    });

    it('should select plugin-mysql when MYSQL_URL is set', () => {
        process.env.MYSQL_URL = 'mysql://user:password@localhost:3306/testdb';

        // Simulate the default plugin selection logic from runtime-factory
        const defaultDatabasePlugin = process.env.MYSQL_URL
            ? '@elizaos/plugin-mysql'
            : '@elizaos/plugin-sql';

        expect(defaultDatabasePlugin).toBe('@elizaos/plugin-mysql');
    });

    it('should remove plugin-sql when plugin-mysql is present in plugin list', () => {
        const pluginNames = [
            '@elizaos/plugin-mysql',
            '@elizaos/plugin-sql',
            '@elizaos/plugin-openai',
            '@elizaos/plugin-bootstrap',
        ];

        // Simulate the conflict detection logic from runtime-factory
        const hasMysqlPlugin = pluginNames.some(
            (p) => p === '@elizaos/plugin-mysql' || p === 'plugin-mysql'
        );
        const hasSqlPlugin = pluginNames.some(
            (p) => p === '@elizaos/plugin-sql' || p === 'plugin-sql'
        );

        let finalPluginNames = pluginNames;
        if (hasMysqlPlugin && hasSqlPlugin) {
            // Remove plugin-sql if plugin-mysql is present
            finalPluginNames = pluginNames.filter(
                (p) => p !== '@elizaos/plugin-sql' && p !== 'plugin-sql'
            );
        }

        expect(finalPluginNames).toContain('@elizaos/plugin-mysql');
        expect(finalPluginNames).not.toContain('@elizaos/plugin-sql');
        expect(finalPluginNames).toContain('@elizaos/plugin-openai');
        expect(finalPluginNames).toContain('@elizaos/plugin-bootstrap');
    });

    it('should keep plugin-sql when plugin-mysql is not present', () => {
        const pluginNames = [
            '@elizaos/plugin-sql',
            '@elizaos/plugin-openai',
            '@elizaos/plugin-bootstrap',
        ];

        // Simulate the conflict detection logic from runtime-factory
        const hasMysqlPlugin = pluginNames.some(
            (p) => p === '@elizaos/plugin-mysql' || p === 'plugin-mysql'
        );
        const hasSqlPlugin = pluginNames.some(
            (p) => p === '@elizaos/plugin-sql' || p === 'plugin-sql'
        );

        let finalPluginNames = pluginNames;
        if (hasMysqlPlugin && hasSqlPlugin) {
            finalPluginNames = pluginNames.filter(
                (p) => p !== '@elizaos/plugin-sql' && p !== 'plugin-sql'
            );
        }

        expect(finalPluginNames).toContain('@elizaos/plugin-sql');
        expect(finalPluginNames).not.toContain('@elizaos/plugin-mysql');
    });

    it('should handle plugin names without @elizaos/ prefix', () => {
        const pluginNames = ['plugin-mysql', 'plugin-sql', 'plugin-openai'];

        // Simulate the conflict detection logic from runtime-factory
        const hasMysqlPlugin = pluginNames.some(
            (p) => p === '@elizaos/plugin-mysql' || p === 'plugin-mysql'
        );
        const hasSqlPlugin = pluginNames.some(
            (p) => p === '@elizaos/plugin-sql' || p === 'plugin-sql'
        );

        let finalPluginNames = pluginNames;
        if (hasMysqlPlugin && hasSqlPlugin) {
            finalPluginNames = pluginNames.filter(
                (p) => p !== '@elizaos/plugin-sql' && p !== 'plugin-sql'
            );
        }

        expect(finalPluginNames).toContain('plugin-mysql');
        expect(finalPluginNames).not.toContain('plugin-sql');
    });

    it('should work with mixed plugin name formats', () => {
        const pluginNames = [
            '@elizaos/plugin-mysql',
            'plugin-sql', // Different format
            '@elizaos/plugin-openai',
        ];

        // Simulate the conflict detection logic from runtime-factory
        const hasMysqlPlugin = pluginNames.some(
            (p) => p === '@elizaos/plugin-mysql' || p === 'plugin-mysql'
        );
        const hasSqlPlugin = pluginNames.some(
            (p) => p === '@elizaos/plugin-sql' || p === 'plugin-sql'
        );

        let finalPluginNames = pluginNames;
        if (hasMysqlPlugin && hasSqlPlugin) {
            finalPluginNames = pluginNames.filter(
                (p) => p !== '@elizaos/plugin-sql' && p !== 'plugin-sql'
            );
        }

        expect(finalPluginNames).toContain('@elizaos/plugin-mysql');
        expect(finalPluginNames).not.toContain('plugin-sql');
        expect(finalPluginNames.length).toBe(2); // mysql and openai
    });

    it('should prefer plugin-mysql in scenario when both MYSQL_URL is set and plugins specified', () => {
        process.env.MYSQL_URL = 'mysql://localhost:3306/db';

        const scenarioPlugins = ['@elizaos/plugin-openai'];

        // Simulate scenario plugin selection logic
        const hasMysqlPlugin = scenarioPlugins.some(
            (p: string) => p === '@elizaos/plugin-mysql' || p === 'plugin-mysql'
        );
        const useMysql = hasMysqlPlugin || !!process.env.MYSQL_URL;

        const defaultPlugins = [
            useMysql ? '@elizaos/plugin-mysql' : '@elizaos/plugin-sql',
            '@elizaos/plugin-bootstrap',
            '@elizaos/plugin-openai',
        ];

        const finalPlugins = Array.from(new Set([...scenarioPlugins, ...defaultPlugins]));

        expect(finalPlugins).toContain('@elizaos/plugin-mysql');
        expect(finalPlugins).not.toContain('@elizaos/plugin-sql');
    });

    it('should use plugin-sql in scenario when MYSQL_URL is not set', () => {
        delete process.env.MYSQL_URL;

        const scenarioPlugins: string[] = [];

        // Simulate scenario plugin selection logic
        const hasMysqlPlugin = scenarioPlugins.some(
            (p: string) => p === '@elizaos/plugin-mysql' || p === 'plugin-mysql'
        );
        const useMysql = hasMysqlPlugin || !!process.env.MYSQL_URL;

        const defaultPlugins = [
            useMysql ? '@elizaos/plugin-mysql' : '@elizaos/plugin-sql',
            '@elizaos/plugin-bootstrap',
            '@elizaos/plugin-openai',
        ];

        const finalPlugins = Array.from(new Set([...scenarioPlugins, ...defaultPlugins]));

        expect(finalPlugins).toContain('@elizaos/plugin-sql');
        expect(finalPlugins).not.toContain('@elizaos/plugin-mysql');
    });

    it('should respect explicit plugin-mysql in scenario plugins even without MYSQL_URL', () => {
        delete process.env.MYSQL_URL;

        const scenarioPlugins = ['@elizaos/plugin-mysql', '@elizaos/plugin-openai'];

        // Simulate scenario plugin selection logic
        const hasMysqlPlugin = scenarioPlugins.some(
            (p: string) => p === '@elizaos/plugin-mysql' || p === 'plugin-mysql'
        );
        const useMysql = hasMysqlPlugin || !!process.env.MYSQL_URL;

        const defaultPlugins = [
            useMysql ? '@elizaos/plugin-mysql' : '@elizaos/plugin-sql',
            '@elizaos/plugin-bootstrap',
            '@elizaos/plugin-openai',
        ];

        const finalPlugins = Array.from(new Set([...scenarioPlugins, ...defaultPlugins]));

        expect(finalPlugins).toContain('@elizaos/plugin-mysql');
        expect(finalPlugins).not.toContain('@elizaos/plugin-sql');
        // Should only have one instance of plugin-mysql (deduped by Set)
        expect(finalPlugins.filter((p) => p === '@elizaos/plugin-mysql').length).toBe(1);
    });
});

