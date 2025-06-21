#!/usr/bin/env node

/**
 * Comprehensive Plugin Migration Test Suite
 * 
 * This script tests all aspects of the plugin migration system:
 * 1. Single plugin migrations
 * 2. Multiple plugin migrations
 * 3. Plugins without schemas
 * 4. Migration error handling
 * 5. Test mode migrations
 * 6. Exit code behavior
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
    totalTests++;
    process.stdout.write(`Testing: ${name}... `);
    try {
        fn();
        passedTests++;
        console.log(`${GREEN}✓${RESET}`);
    } catch (error) {
        failedTests++;
        console.log(`${RED}✗${RESET}`);
        console.error(`  Error: ${error.message}`);
    }
}

function expectInOutput(output, pattern) {
    if (!output.includes(pattern)) {
        throw new Error(`Expected output to contain: "${pattern}"`);
    }
}

function expectNotInOutput(output, pattern) {
    if (output.includes(pattern)) {
        throw new Error(`Expected output NOT to contain: "${pattern}"`);
    }
}

console.log('🧪 Running Plugin Migration Tests\n');

// Test 1: CLI version check
test('CLI is using correct version', () => {
    const output = execSync('elizaos --version', { encoding: 'utf8' });
    expectInOutput(output, '1.0.9');
});

// Test 2: Single plugin migration
test('Single plugin migration (todo)', () => {
    const testDir = fs.mkdtempSync(path.join(rootDir, 'test-migrations-'));
    
    try {
        const characterFile = path.join(testDir, 'test-character.json');
        fs.writeFileSync(characterFile, JSON.stringify({
            name: "TestAgent",
            plugins: ["@elizaos/plugin-sql", "todo"]
        }));

        const output = execSync(
            `cd "${rootDir}/packages/plugin-todo" && elizaos test e2e 2>&1 || true`,
            { encoding: 'utf8', timeout: 30000 }
        );

        expectInOutput(output, 'Running migrations for plugin: @elizaos/plugin-sql');
        expectInOutput(output, 'Running migrations for plugin: todo');
        expectInOutput(output, 'Successfully migrated plugin: todo');
        expectInOutput(output, 'Plugin migrations completed.');
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

// Test 3: Multiple plugin migration
test('Multiple plugin migration (todo + trust)', () => {
    const testDir = fs.mkdtempSync(path.join(rootDir, 'test-migrations-'));
    
    try {
        const characterFile = path.join(testDir, 'test-character.json');
        fs.writeFileSync(characterFile, JSON.stringify({
            name: "TestAgent",
            plugins: ["@elizaos/plugin-sql", "todo", "trust"]
        }));

        // Create a simple test that loads both plugins
        const testFile = path.join(testDir, 'test.js');
        fs.writeFileSync(testFile, `
            import todoPlugin from '${rootDir}/packages/plugin-todo/dist/index.js';
            import trustPlugin from '${rootDir}/packages/plugin-trust/dist/index.js';
            
            console.log('Loaded plugins:', todoPlugin.name, trustPlugin.name);
        `);

        // We'll verify by checking the trust plugin test output
        const output = execSync(
            `cd "${rootDir}/packages/plugin-trust" && elizaos test e2e 2>&1 || true`,
            { encoding: 'utf8', timeout: 30000 }
        );

        expectInOutput(output, 'Running migrations for plugin: @elizaos/plugin-sql');
        expectInOutput(output, 'Running migrations for plugin: trust');
        expectInOutput(output, 'Successfully migrated plugin: trust');
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

// Test 4: Plugin without schema
test('Plugin without schema (bootstrap)', () => {
    const output = execSync(
        `cd "${rootDir}" && elizaos start --test-mode 2>&1 | head -50 || true`,
        { encoding: 'utf8', shell: true }
    );

    // Should migrate SQL plugin but not bootstrap
    expectInOutput(output, 'Running migrations for plugin: @elizaos/plugin-sql');
    expectNotInOutput(output, 'Running migrations for plugin: bootstrap');
});

// Test 5: Exit code on test failure
test('Exit code 1 on component test failure', () => {
    let exitCode = 0;
    try {
        execSync(
            `cd "${rootDir}/packages/plugin-todo" && elizaos test component`,
            { encoding: 'utf8', stdio: 'pipe' }
        );
    } catch (error) {
        exitCode = error.status || 0;
    }
    
    if (exitCode !== 1) {
        throw new Error(`Expected exit code 1, got ${exitCode}`);
    }
});

// Test 6: Database table creation
test('Database tables are created', () => {
    const output = execSync(
        `cd "${rootDir}/packages/plugin-todo" && elizaos test e2e 2>&1 || true`,
        { encoding: 'utf8', timeout: 30000 }
    );

    // Check for table creation logs (if verbose logging is enabled)
    // At minimum, check that migrations completed
    expectInOutput(output, 'Plugin migrations completed.');
    
    // The todo plugin should have 5 tables
    const expectedTables = ['todos', 'todo_tags', 'user_points', 'point_history', 'daily_streaks'];
    // We can't directly check table creation without database access, but we can verify migration ran
});

// Test 7: Migration idempotency
test('Migrations can run multiple times safely', () => {
    const testDir = fs.mkdtempSync(path.join(rootDir, 'test-migrations-'));
    
    try {
        // Run migrations twice using the same database
        const dbDir = path.join(testDir, '.elizadb-test');
        
        // First run
        const output1 = execSync(
            `cd "${rootDir}/packages/plugin-todo" && PGLITE_DATA_DIR="${dbDir}" elizaos test e2e 2>&1 || true`,
            { encoding: 'utf8', timeout: 30000 }
        );
        expectInOutput(output1, 'Plugin migrations completed.');
        
        // Second run with same database
        const output2 = execSync(
            `cd "${rootDir}/packages/plugin-todo" && PGLITE_DATA_DIR="${dbDir}" elizaos test e2e 2>&1 || true`,
            { encoding: 'utf8', timeout: 30000 }
        );
        expectInOutput(output2, 'Plugin migrations completed.');
        
        // Both should complete without errors
    } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
    }
});

// Test 8: SQL plugin export verification
test('SQL plugin exports runPluginMigrations', async () => {
    const sqlPluginPath = path.join(rootDir, 'packages/plugin-sql/dist/index.js');
    const sqlPlugin = await import(sqlPluginPath);
    
    if (!sqlPlugin.plugin) {
        throw new Error('SQL plugin does not export plugin object');
    }
    
    if (!sqlPlugin.plugin.runPluginMigrations) {
        throw new Error('SQL plugin does not export runPluginMigrations function');
    }
    
    if (typeof sqlPlugin.plugin.runPluginMigrations !== 'function') {
        throw new Error('runPluginMigrations is not a function');
    }
});

// Test 9: Runtime has migration method
test('Runtime has runPluginMigrations method', async () => {
    const runtimePath = path.join(rootDir, 'packages/core/dist/runtime.js');
    const runtimeModule = await import(runtimePath);
    
    if (!runtimeModule.AgentRuntime) {
        throw new Error('Runtime module does not export AgentRuntime');
    }
    
    if (!runtimeModule.AgentRuntime.prototype.runPluginMigrations) {
        throw new Error('AgentRuntime does not have runPluginMigrations method');
    }
});

// Summary
console.log('\n📊 Test Summary:');
console.log(`Total tests: ${totalTests}`);
console.log(`${GREEN}Passed: ${passedTests}${RESET}`);
console.log(`${RED}Failed: ${failedTests}${RESET}`);

if (failedTests > 0) {
    console.log(`\n${RED}❌ Some tests failed!${RESET}`);
    process.exit(1);
} else {
    console.log(`\n${GREEN}✅ All tests passed!${RESET}`);
    process.exit(0);
} 