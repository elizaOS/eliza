#!/usr/bin/env bun

import { PluginParser } from './src/scenarios/plugin-parser';
import { PluginReference } from './src/scenarios/schema';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

async function testPluginParsing() {
    console.log('🧪 Testing Plugin Parsing and Validation...\n');

    // Test 1: Parse the test scenario file
    console.log('📋 Test 1: Parsing scenario file...');
    const scenarioPath = path.join(__dirname, 'src/commands/scenario/examples/plugin-parsing-test.scenario.yaml');

    if (!fs.existsSync(scenarioPath)) {
        console.error('❌ Test scenario file not found:', scenarioPath);
        return;
    }

    const scenarioContent = fs.readFileSync(scenarioPath, 'utf8');
    const scenario = yaml.load(scenarioContent) as any;

    console.log('✅ Scenario loaded successfully');
    console.log(`📊 Found ${scenario.plugins?.length || 0} plugin references\n`);

    // Test 2: Parse and validate plugins
    console.log('🔍 Test 2: Parsing and validating plugins...');
    const result = await PluginParser.parseAndValidate(scenario.plugins);

    console.log(PluginParser.generateSummary(result));
    console.log('');

    // Test 3: Test various plugin configurations
    console.log('🧪 Test 3: Testing various plugin configurations...');

    const testCases: Array<{ name: string; plugins: PluginReference[] }> = [
        {
            name: 'Empty plugins array',
            plugins: []
        },
        {
            name: 'Simple string references',
            plugins: ['@elizaos/plugin-sql', '@elizaos/plugin-e2b']
        },
        {
            name: 'Mixed string and object references',
            plugins: [
                '@elizaos/plugin-sql',
                { name: '@elizaos/plugin-openai', enabled: true }
            ]
        },
        {
            name: 'Invalid plugin names',
            plugins: [
                'invalid-plugin',
                '@elizaos/plugin-sql'
            ]
        },
        {
            name: 'Duplicate plugins',
            plugins: [
                '@elizaos/plugin-sql',
                '@elizaos/plugin-sql'
            ]
        },
        {
            name: 'Disabled plugins',
            plugins: [
                { name: '@elizaos/plugin-sql', enabled: false },
                { name: '@elizaos/plugin-e2b', enabled: true }
            ]
        },
        {
            name: 'Complex configuration',
            plugins: [
                {
                    name: '@elizaos/plugin-openai',
                    version: '1.0.0',
                    config: { model: 'gpt-4', temperature: 0.7 },
                    enabled: true
                },
                {
                    name: '@elizaos/plugin-sql',
                    config: { connectionPool: 10 },
                    enabled: true
                }
            ]
        }
    ];

    for (const testCase of testCases) {
        console.log(`\n📝 Testing: ${testCase.name}`);
        const testResult = await PluginParser.parseAndValidate(testCase.plugins);

        console.log(`  Valid: ${testResult.valid ? '✅' : '❌'}`);
        console.log(`  Plugins to load: ${testResult.plugins.length}`);

        if (testResult.errors.length > 0) {
            console.log(`  Errors: ${testResult.errors.length}`);
            testResult.errors.forEach(error => console.log(`    - ${error}`));
        }

        if (testResult.warnings.length > 0) {
            console.log(`  Warnings: ${testResult.warnings.length}`);
            testResult.warnings.forEach(warning => console.log(`    - ${warning}`));
        }
    }

    // Test 4: Show dynamic plugin loading capabilities
    console.log('\n📋 Test 4: Dynamic plugin loading capabilities...');
    console.log('The plugin parser now dynamically loads and validates plugins');
    console.log('instead of using a static list. This allows for:');
    console.log('  - Any @elizaos/plugin-* package to be used');
    console.log('  - Automatic installation of missing plugins');
    console.log('  - Real-time validation of plugin compatibility');

    console.log('\n🎉 Plugin parsing tests completed!');
}

testPluginParsing().catch(console.error); 