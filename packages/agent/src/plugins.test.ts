import dotenv from 'dotenv';
dotenv.config({ path: '../../.env' });

import type { IDatabaseAdapter, IDatabaseCacheAdapter, TestCase } from "@elizaos/core";
import {
    AgentRuntime,
    CacheManager,
    DbCacheAdapter,
    logger,
    stringToUuid,
    type TestSuite,
    type IAgentRuntime,
    type Character
} from "@elizaos/core";
import { afterAll, beforeAll, describe, it } from 'vitest';
import { defaultCharacter } from './single-agent/character';

const TEST_TIMEOUT = 300000;

const defaultCharacterTest: Character = {
    ...defaultCharacter,
};

const elizaOpenAIFirst: Character = {
    ...defaultCharacter,
    name: "ElizaOpenAIFirst",
    plugins: [
        "@elizaos/plugin-openai",  // OpenAI first = 1536 embedding
        "@elizaos/plugin-anthropic",
        "@elizaos/plugin-elevenlabs",
    ]
};

const elizaAnthropicFirst: Character = {
    ...defaultCharacter,
    name: "ElizaAnthropicFirst",
    plugins: [
        "@elizaos/plugin-anthropic", // Anthropic first = 384 embedding
        "@elizaos/plugin-openai",
        "@elizaos/plugin-elevenlabs",
    ]
};

// Store runtimes and database adapters for each character
interface RuntimeConfig {
    runtime: IAgentRuntime;
    db: IDatabaseAdapter & IDatabaseCacheAdapter;
}

const runtimeConfigs = new Map<string, RuntimeConfig>();

// Helper to create a database adapter
async function findDatabaseAdapter(runtime: IAgentRuntime) {
    const { adapters } = runtime;
    let adapter;
    
    if (adapters.length === 0) {
        const drizzleAdapter = await import('@elizaos/plugin-drizzle');
        adapter = drizzleAdapter.default.adapters[0];
        if (!adapter) {
            throw new Error("No database adapter found in default drizzle plugin");
        }
    } else if (adapters.length === 1) {
        adapter = adapters[0];
    } else {
        throw new Error("Multiple database adapters found. Ensure only one database adapter plugin is loaded.");
    }
    
    return adapter.init(runtime);
}

// Initialize runtime for a character
async function initializeRuntime(character: Character): Promise<RuntimeConfig> {
    try {
        character.id = stringToUuid(character.name);

        const runtime = new AgentRuntime({
            character,
            fetch: async (url: string, options: any) => {
                logger.debug(`Test fetch: ${url}`);
                return fetch(url, options);
            }
        });

        const db = await findDatabaseAdapter(runtime);
        runtime.databaseAdapter = db;

        const cache = new CacheManager(new DbCacheAdapter(db, character.id));
        runtime.cacheManager = cache;

        await runtime.initialize();

        logger.info(`Test runtime initialized for ${character.name}`);
        
        // Log expected embedding dimension based on plugins
        const hasOpenAIFirst = character.plugins[0] === "@elizaos/plugin-openai";
        const expectedDimension = hasOpenAIFirst ? 1536 : 384;
        logger.info(`Expected embedding dimension for ${character.name}: ${expectedDimension}`);
        
        return { runtime, db };
    } catch (error) {
        logger.error(`Failed to initialize test runtime for ${character.name}:`, error);
        throw error;
    }
}

// Initialize the runtimes
beforeAll(async () => {
    const characters = [defaultCharacterTest, elizaOpenAIFirst, elizaAnthropicFirst];
    
    for (const character of characters) {
        const config = await initializeRuntime(character);
        runtimeConfigs.set(character.name, config);
    }
}, TEST_TIMEOUT);

// Cleanup after all tests
afterAll(async () => {
    for (const [characterName, config] of runtimeConfigs.entries()) {
        try {
            if (config.db) {
                await config.db.close();
            }
            logger.info(`Cleaned up ${characterName}`);
        } catch (error) {
            logger.error(`Error during cleanup for ${characterName}:`, error);
        }
    }
});

// Test suite for each character
describe('Multi-Character Plugin Tests', () => {
    it('should run tests for Default Character', async () => {
        const config = runtimeConfigs.get(defaultCharacter.name);
        if (!config) throw new Error('Runtime not found for Default Character');
        
        const testRunner = new TestRunner(config.runtime);
        await testRunner.runPluginTests();
    }, TEST_TIMEOUT);

    it('should run tests for ElizaOpenAIFirst (1536 dimension)', async () => {
        const config = runtimeConfigs.get('ElizaOpenAIFirst');
        if (!config) throw new Error('Runtime not found for ElizaOpenAIFirst');
        
        const testRunner = new TestRunner(config.runtime);
        await testRunner.runPluginTests();
    }, TEST_TIMEOUT);

    it('should run tests for ElizaAnthropicFirst (384 dimension)', async () => {
        const config = runtimeConfigs.get('ElizaAnthropicFirst');
        if (!config) throw new Error('Runtime not found for ElizaAnthropicFirst');
        
        const testRunner = new TestRunner(config.runtime);
        await testRunner.runPluginTests();
    }, TEST_TIMEOUT);
});

interface TestStats {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
}

class TestRunner {
    private runtime: IAgentRuntime;
    private stats: TestStats;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.stats = {
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0
        };
    }

    private async runTestCase(test: TestCase): Promise<void> {
        const startTime = performance.now();
        try {
            await test.fn(this.runtime);
            this.stats.passed++;
            const duration = performance.now() - startTime;
            logger.info(`✓ ${test.name} (${Math.round(duration)}ms)`);
        } catch (error) {
            this.stats.failed++;
            logger.error(`✗ ${test.name}`);
            logger.error(error);
        }
    }

    private async runTestSuite(suite: TestSuite): Promise<void> {
        logger.info(`\nTest suite: ${suite.name}`);
        for (const test of suite.tests) {
            this.stats.total++;
            await this.runTestCase(test);
        }
    }

    public async runPluginTests(): Promise<TestStats> {
        const plugins = this.runtime.plugins;

        for (const plugin of plugins) {
            try {
                logger.info(`Running tests for plugin: ${plugin.name}`);
                const pluginTests = plugin.tests;
                // Handle both single suite and array of suites
                const testSuites = Array.isArray(pluginTests) ? pluginTests : [pluginTests];

                for (const suite of testSuites) {
                    if (suite) {
                        await this.runTestSuite(suite);
                    }
                }
            } catch (error) {
                logger.error(`Error in plugin ${plugin.name}:`, error);
                throw error;
            }
        }

        this.logTestSummary();
        return this.stats;
    }

    private logTestSummary(): void {
        logger.info('\nTest Summary:');
        logger.info(`Total: ${this.stats.total}`);
        logger.info(`Passed: ${this.stats.passed}`);
        logger.info(`Failed: ${this.stats.failed}`);
        logger.info(`Skipped: ${this.stats.skipped}`);
    }
}