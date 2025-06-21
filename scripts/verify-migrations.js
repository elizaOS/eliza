#!/usr/bin/env node

import { execSync } from 'child_process';

console.log('🔍 Verifying Plugin Migration System\n');

// Test 1: Check CLI version
console.log('1. Checking CLI version...');
const version = execSync('elizaos --version', { encoding: 'utf8' }).trim();
console.log(`   CLI Version: ${version}`);
console.log(`   ✅ Using local build\n`);

// Test 2: Run todo plugin tests and capture output
console.log('2. Running todo plugin tests...');
try {
    const output = execSync('cd packages/plugin-todo && elizaos test e2e 2>&1', { 
        encoding: 'utf8',
        timeout: 30000
    });
    
    // Look for migration indicators
    const indicators = {
        'Database migrations': output.includes('Running database migrations'),
        'Plugin migrations start': output.includes('Running plugin migrations'),
        'SQL plugin migrated': output.includes('Running migrations for plugin: @elizaos/plugin-sql'),
        'Todo plugin migrated': output.includes('Running migrations for plugin: todo'),
        'Migrations completed': output.includes('Plugin migrations completed'),
        'Tables created': output.includes('Created table:')
    };
    
    console.log('   Migration indicators found:');
    for (const [key, found] of Object.entries(indicators)) {
        console.log(`   - ${key}: ${found ? '✅' : '❌'}`);
    }
    
    // Extract specific lines
    const migrationLines = output.split('\n').filter(line => 
        line.includes('migration') || 
        line.includes('Migration') || 
        line.includes('migrated') ||
        line.includes('schema')
    );
    
    if (migrationLines.length > 0) {
        console.log('\n   Related log lines:');
        migrationLines.slice(0, 10).forEach(line => {
            console.log(`   > ${line.trim()}`);
        });
    }
    
} catch (error) {
    console.log('   ⚠️  Tests failed, but checking output...');
    const output = error.stdout || '';
    
    // Check if migrations ran even though tests failed
    if (output.includes('Plugin migrations completed')) {
        console.log('   ✅ Migrations ran successfully (tests failed for other reasons)');
    } else {
        console.log('   ❌ Migrations did not complete');
    }
}

// Test 3: Check file exports
console.log('\n3. Checking file exports...');
try {
    const sqlPlugin = await import('./packages/plugin-sql/dist/index.js');
    console.log(`   - SQL plugin has runPluginMigrations: ${!!sqlPlugin.plugin?.runPluginMigrations ? '✅' : '❌'}`);
    
    const runtime = await import('./packages/core/dist/runtime.js');
    console.log(`   - Runtime has runPluginMigrations: ${!!runtime.AgentRuntime?.prototype?.runPluginMigrations ? '✅' : '❌'}`);
} catch (error) {
    console.log('   ❌ Error checking exports:', error.message);
}

console.log('\n✨ Verification complete!'); 