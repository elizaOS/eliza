/**
 * MySQL Plugin Compatibility Tests
 * Tests the server's ability to conditionally load plugin-mysql vs plugin-sql
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { AgentServer } from '../index';
import type { ServerConfig } from '../index';

describe('MySQL Plugin Compatibility Tests', () => {
    let server: AgentServer;
    let originalMysqlUrl: string | undefined;

    beforeEach(() => {
        // Save original env var
        originalMysqlUrl = process.env.MYSQL_URL;

        server = new AgentServer();
    });

    afterEach(async () => {
        // Restore original env var
        if (originalMysqlUrl !== undefined) {
            process.env.MYSQL_URL = originalMysqlUrl;
        } else {
            delete process.env.MYSQL_URL;
        }

        if (server) {
            await server.stop().catch(() => { });
            server = null as any;
        }
    });

    it('should use plugin-sql when MYSQL_URL is not set', async () => {
        // Ensure MYSQL_URL is not set
        delete process.env.MYSQL_URL;

        let sqlPluginLoaded = false;
        let mysqlPluginLoaded = false;

        // Mock both plugins
        mock.module('@elizaos/plugin-sql', () => {
            sqlPluginLoaded = true;
            return {
                default: { name: 'sql', description: 'SQL plugin' },
                createDatabaseAdapter: mock(() => ({
                    init: mock().mockResolvedValue(undefined),
                    close: mock().mockResolvedValue(undefined),
                    getDatabase: mock(() => ({
                        execute: mock().mockResolvedValue([]),
                    })),
                    getMessageServers: mock()
                        .mockResolvedValueOnce([])
                        .mockResolvedValue([
                            { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
                        ]),
                    createMessageServer: mock().mockResolvedValue({
                        id: '00000000-0000-0000-0000-000000000000',
                    }),
                    getMessageServerById: mock().mockResolvedValue({
                        id: '00000000-0000-0000-0000-000000000000',
                        name: 'Default Server',
                    }),
                    addAgentToServer: mock().mockResolvedValue(undefined),
                    getChannelsForServer: mock().mockResolvedValue([]),
                    createChannel: mock().mockResolvedValue({
                        id: '123e4567-e89b-12d3-a456-426614174000',
                    }),
                    getAgentsForServer: mock().mockResolvedValue([]),
                    db: { execute: mock().mockResolvedValue([]) },
                })),
                DatabaseMigrationService: mock(() => ({
                    initializeWithDatabase: mock().mockResolvedValue(undefined),
                    discoverAndRegisterPluginSchemas: mock(),
                    runAllPluginMigrations: mock().mockResolvedValue(undefined),
                })),
            };
        });

        mock.module('@elizaos/plugin-mysql', () => {
            mysqlPluginLoaded = true;
            return {
                default: { name: 'mysql', description: 'MySQL plugin' },
                createDatabaseAdapter: mock(() => ({
                    init: mock().mockResolvedValue(undefined),
                    close: mock().mockResolvedValue(undefined),
                })),
            };
        });

        await server.start({ isTestMode: true });

        expect(sqlPluginLoaded).toBe(true);
        expect(mysqlPluginLoaded).toBe(false);
        expect(server.isInitialized).toBe(true);
    });

    it('should use plugin-mysql when MYSQL_URL is set', async () => {
        // Set MYSQL_URL
        process.env.MYSQL_URL = 'mysql://user:password@localhost:3306/testdb';

        let sqlPluginLoaded = false;
        let mysqlPluginLoaded = false;

        // Mock both plugins
        mock.module('@elizaos/plugin-sql', () => {
            sqlPluginLoaded = true;
            return {
                default: { name: 'sql', description: 'SQL plugin' },
                createDatabaseAdapter: mock(() => ({
                    init: mock().mockResolvedValue(undefined),
                })),
            };
        });

        mock.module('@elizaos/plugin-mysql', () => {
            mysqlPluginLoaded = true;
            return {
                default: { name: 'mysql', description: 'MySQL plugin' },
                createDatabaseAdapter: mock(({ mysqlUrl }) => {
                    expect(mysqlUrl).toBe('mysql://user:password@localhost:3306/testdb');
                    return {
                        init: mock().mockResolvedValue(undefined),
                        close: mock().mockResolvedValue(undefined),
                        getDatabase: mock(() => ({
                            execute: mock().mockResolvedValue([]),
                        })),
                        getMessageServers: mock()
                            .mockResolvedValueOnce([])
                            .mockResolvedValue([
                                { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
                            ]),
                        createMessageServer: mock().mockResolvedValue({
                            id: '00000000-0000-0000-0000-000000000000',
                        }),
                        getMessageServerById: mock().mockResolvedValue({
                            id: '00000000-0000-0000-0000-000000000000',
                            name: 'Default Server',
                        }),
                        addAgentToServer: mock().mockResolvedValue(undefined),
                        getChannelsForServer: mock().mockResolvedValue([]),
                        createChannel: mock().mockResolvedValue({
                            id: '123e4567-e89b-12d3-a456-426614174000',
                        }),
                        getAgentsForServer: mock().mockResolvedValue([]),
                        db: { execute: mock().mockResolvedValue([]) },
                    };
                }),
            };
        });

        await server.start({ isTestMode: true });

        expect(mysqlPluginLoaded).toBe(true);
        expect(sqlPluginLoaded).toBe(false);
        expect(server.isInitialized).toBe(true);
    });

    it('should skip RLS initialization when using MySQL', async () => {
        // Set both MYSQL_URL and RLS flags
        process.env.MYSQL_URL = 'mysql://user:password@localhost:3306/testdb';
        process.env.ENABLE_RLS_ISOLATION = 'true';
        process.env.RLS_OWNER_ID = 'test-owner';

        let rlsFunctionsImported = false;

        // Mock MySQL plugin
        mock.module('@elizaos/plugin-mysql', () => ({
            default: { name: 'mysql', description: 'MySQL plugin' },
            createDatabaseAdapter: mock(() => ({
                init: mock().mockResolvedValue(undefined),
                close: mock().mockResolvedValue(undefined),
                getDatabase: mock(() => ({
                    execute: mock().mockResolvedValue([]),
                })),
                getMessageServers: mock()
                    .mockResolvedValueOnce([])
                    .mockResolvedValue([
                        { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
                    ]),
                createMessageServer: mock().mockResolvedValue({
                    id: '00000000-0000-0000-0000-000000000000',
                }),
                getMessageServerById: mock().mockResolvedValue({
                    id: '00000000-0000-0000-0000-000000000000',
                    name: 'Default Server',
                }),
                addAgentToServer: mock().mockResolvedValue(undefined),
                getChannelsForServer: mock().mockResolvedValue([]),
                createChannel: mock().mockResolvedValue({
                    id: '123e4567-e89b-12d3-a456-426614174000',
                }),
                getAgentsForServer: mock().mockResolvedValue([]),
                db: { execute: mock().mockResolvedValue([]) },
            })),
        }));

        // Mock SQL plugin RLS functions (they should NOT be called)
        mock.module('@elizaos/plugin-sql', () => {
            rlsFunctionsImported = true;
            return {
                installRLSFunctions: mock(() => {
                    throw new Error('RLS functions should not be called with MySQL');
                }),
                getOrCreateRlsOwner: mock(),
                setOwnerContext: mock(),
                applyRLSToNewTables: mock(),
            };
        });

        const config: ServerConfig = {
            isTestMode: true,
        };

        await server.start(config);

        expect(server.isInitialized).toBe(true);
        // RLS functions should not have been imported when using MySQL
        expect(rlsFunctionsImported).toBe(false);
    });

    it('should handle MySQL connection string with special characters', async () => {
        const mysqlUrl = 'mysql://user:p@ss%23word@localhost:3306/db?charset=utf8';
        process.env.MYSQL_URL = mysqlUrl;

        let receivedConfig: any = null;

        mock.module('@elizaos/plugin-mysql', () => ({
            default: { name: 'mysql', description: 'MySQL plugin' },
            createDatabaseAdapter: mock((config) => {
                receivedConfig = config;
                return {
                    init: mock().mockResolvedValue(undefined),
                    close: mock().mockResolvedValue(undefined),
                    getDatabase: mock(() => ({
                        execute: mock().mockResolvedValue([]),
                    })),
                    getMessageServers: mock()
                        .mockResolvedValueOnce([])
                        .mockResolvedValue([
                            { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
                        ]),
                    createMessageServer: mock().mockResolvedValue({
                        id: '00000000-0000-0000-0000-000000000000',
                    }),
                    getMessageServerById: mock().mockResolvedValue({
                        id: '00000000-0000-0000-0000-000000000000',
                        name: 'Default Server',
                    }),
                    addAgentToServer: mock().mockResolvedValue(undefined),
                    getChannelsForServer: mock().mockResolvedValue([]),
                    createChannel: mock().mockResolvedValue({
                        id: '123e4567-e89b-12d3-a456-426614174000',
                    }),
                    getAgentsForServer: mock().mockResolvedValue([]),
                    db: { execute: mock().mockResolvedValue([]) },
                };
            }),
        }));

        await server.start({ isTestMode: true });

        expect(receivedConfig).toBeDefined();
        expect(receivedConfig.mysqlUrl).toBe(mysqlUrl);
    });

    it('should provide no-op migration service for MySQL', async () => {
        process.env.MYSQL_URL = 'mysql://user:password@localhost:3306/testdb';

        let migrationServiceCreated = false;
        let migrationMethodsCalled: string[] = [];

        mock.module('@elizaos/plugin-mysql', () => ({
            default: { name: 'mysql', description: 'MySQL plugin' },
            createDatabaseAdapter: mock(() => ({
                init: mock().mockResolvedValue(undefined),
                close: mock().mockResolvedValue(undefined),
                getDatabase: mock(() => {
                    migrationServiceCreated = true;
                    return {
                        execute: mock().mockResolvedValue([]),
                    };
                }),
                getMessageServers: mock()
                    .mockResolvedValueOnce([])
                    .mockResolvedValue([
                        { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
                    ]),
                createMessageServer: mock().mockResolvedValue({
                    id: '00000000-0000-0000-0000-000000000000',
                }),
                getMessageServerById: mock().mockResolvedValue({
                    id: '00000000-0000-0000-0000-000000000000',
                    name: 'Default Server',
                }),
                addAgentToServer: mock().mockResolvedValue(undefined),
                getChannelsForServer: mock().mockResolvedValue([]),
                createChannel: mock().mockResolvedValue({
                    id: '123e4567-e89b-12d3-a456-426614174000',
                }),
                getAgentsForServer: mock().mockResolvedValue([]),
                db: { execute: mock().mockResolvedValue([]) },
            })),
        }));

        await server.start({ isTestMode: true });

        expect(migrationServiceCreated).toBe(true);
        expect(server.isInitialized).toBe(true);
    });

    it('should not load both plugin-sql and plugin-mysql simultaneously', async () => {
        process.env.MYSQL_URL = 'mysql://user:password@localhost:3306/testdb';

        const pluginsLoaded: string[] = [];

        mock.module('@elizaos/plugin-mysql', () => {
            pluginsLoaded.push('mysql');
            return {
                default: { name: 'mysql', description: 'MySQL plugin' },
                createDatabaseAdapter: mock(() => ({
                    init: mock().mockResolvedValue(undefined),
                    close: mock().mockResolvedValue(undefined),
                    getDatabase: mock(() => ({
                        execute: mock().mockResolvedValue([]),
                    })),
                    getMessageServers: mock()
                        .mockResolvedValueOnce([])
                        .mockResolvedValue([
                            { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
                        ]),
                    createMessageServer: mock().mockResolvedValue({
                        id: '00000000-0000-0000-0000-000000000000',
                    }),
                    getMessageServerById: mock().mockResolvedValue({
                        id: '00000000-0000-0000-0000-000000000000',
                        name: 'Default Server',
                    }),
                    addAgentToServer: mock().mockResolvedValue(undefined),
                    getChannelsForServer: mock().mockResolvedValue([]),
                    createChannel: mock().mockResolvedValue({
                        id: '123e4567-e89b-12d3-a456-426614174000',
                    }),
                    getAgentsForServer: mock().mockResolvedValue([]),
                    db: { execute: mock().mockResolvedValue([]) },
                })),
            };
        });

        mock.module('@elizaos/plugin-sql', () => {
            pluginsLoaded.push('sql');
            return {
                default: { name: 'sql', description: 'SQL plugin' },
                createDatabaseAdapter: mock(() => ({
                    init: mock().mockResolvedValue(undefined),
                })),
            };
        });

        await server.start({ isTestMode: true });

        // Should only load mysql plugin
        expect(pluginsLoaded).toEqual(['mysql']);
        expect(pluginsLoaded).not.toContain('sql');
    });
});

