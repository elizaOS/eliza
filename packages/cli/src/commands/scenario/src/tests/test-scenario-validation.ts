#!/usr/bin/env bun

import { ScenarioSchema } from '../schema';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

async function testScenarioValidation() {
    console.log('🧪 Testing Scenario Schema Validation...\n');

    // Test 1: Validate the plugin parsing test scenario
    console.log('📋 Test 1: Validating plugin parsing test scenario...');
    const scenarioPath = path.join(__dirname, 'src/commands/scenario/examples/plugin-parsing-test.scenario.yaml');

    if (!fs.existsSync(scenarioPath)) {
        console.error('❌ Test scenario file not found:', scenarioPath);
        return;
    }

    const scenarioContent = fs.readFileSync(scenarioPath, 'utf8');
    const rawScenario = yaml.load(scenarioContent);

    console.log('✅ YAML loaded successfully');
    console.log('🔍 Validating against schema...');

    const validationResult = ScenarioSchema.safeParse(rawScenario);

    if (validationResult.success) {
        console.log('✅ Scenario validation passed!');
        console.log(`📊 Scenario details:`);
        console.log(`  Name: ${validationResult.data.name}`);
        console.log(`  Description: ${validationResult.data.description}`);
        console.log(`  Environment: ${validationResult.data.environment.type}`);
        console.log(`  Plugins: ${validationResult.data.plugins?.length || 0}`);
        console.log(`  Run steps: ${validationResult.data.run.length}`);
        console.log(`  Judgment strategy: ${validationResult.data.judgment.strategy}`);
    } else {
        console.log('❌ Scenario validation failed:');
        console.log(JSON.stringify(validationResult.error.format(), null, 2));
    }

    console.log('\n📋 Test 2: Testing various plugin configurations in schema...');

    const testScenarios = [
        {
            name: 'Simple string plugins',
            scenario: {
                name: 'Test',
                description: 'Test',
                plugins: ['@elizaos/plugin-sql', '@elizaos/plugin-e2b'],
                environment: { type: 'local' },
                run: [{ lang: 'javascript', code: 'console.log("test")', evaluations: [] }],
                judgment: { strategy: 'all_pass' }
            }
        },
        {
            name: 'Mixed plugin types',
            scenario: {
                name: 'Test',
                description: 'Test',
                plugins: [
                    '@elizaos/plugin-sql',
                    { name: '@elizaos/plugin-openai', enabled: true }
                ],
                environment: { type: 'local' },
                run: [{ lang: 'javascript', code: 'console.log("test")', evaluations: [] }],
                judgment: { strategy: 'all_pass' }
            }
        },
        {
            name: 'Complex plugin configuration',
            scenario: {
                name: 'Test',
                description: 'Test',
                plugins: [
                    {
                        name: '@elizaos/plugin-openai',
                        version: '1.0.0',
                        config: { model: 'gpt-4' },
                        enabled: true
                    }
                ],
                environment: { type: 'local' },
                run: [{ lang: 'javascript', code: 'console.log("test")', evaluations: [] }],
                judgment: { strategy: 'all_pass' }
            }
        },
        {
            name: 'No plugins specified',
            scenario: {
                name: 'Test',
                description: 'Test',
                environment: { type: 'local' },
                run: [{ lang: 'javascript', code: 'console.log("test")', evaluations: [] }],
                judgment: { strategy: 'all_pass' }
            }
        }
    ];

    for (const testCase of testScenarios) {
        console.log(`\n📝 Testing: ${testCase.name}`);
        const result = ScenarioSchema.safeParse(testCase.scenario);

        if (result.success) {
            console.log('  ✅ Valid');
            console.log(`  📊 Plugins: ${result.data.plugins?.length || 0}`);
        } else {
            console.log('  ❌ Invalid');
            console.log(`  🚨 Errors: ${result.error.errors.length}`);
        }
    }

    console.log('\n🎉 Scenario validation tests completed!');
}

testScenarioValidation().catch(console.error); 