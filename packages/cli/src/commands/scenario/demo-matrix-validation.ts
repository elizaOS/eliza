#!/usr/bin/env bun

/**
 * Demo script to show matrix configuration validation in action
 * Run with: bun packages/cli/src/commands/scenario/demo-matrix-validation.ts
 */

import { readFileSync } from 'fs';
import { load } from 'js-yaml';
import {
    validateMatrixConfig,
    calculateTotalCombinations,
    calculateTotalRuns,
    generateParameterCombinations
} from './src/matrix-schema';

console.log('🧪 Matrix Configuration Validation Demo\n');

// Load and validate our example matrix configuration
try {
    const examplePath = './src/commands/scenario/examples/github-issue-analysis.matrix.yaml';
    console.log(`📂 Loading: ${examplePath}`);

    const fileContents = readFileSync(examplePath, 'utf8');
    const yamlData = load(fileContents);

    console.log('📋 Raw YAML data:');
    console.log(JSON.stringify(yamlData, null, 2));
    console.log();

    // Validate the configuration
    console.log('✅ Validating configuration...');
    const result = validateMatrixConfig(yamlData);

    if (!result.success) {
        console.error('❌ Validation failed:');
        console.error(result.error.format());
        process.exit(1);
    }

    console.log('✅ Configuration is valid!');
    console.log();

    const config = result.data;

    // Calculate combinations
    const totalCombinations = calculateTotalCombinations(config);
    const totalRuns = calculateTotalRuns(config);

    console.log('📊 Matrix Analysis:');
    console.log(`   Name: ${config.name}`);
    console.log(`   Base Scenario: ${config.base_scenario}`);
    console.log(`   Runs per combination: ${config.runs_per_combination}`);
    console.log(`   Number of axes: ${config.matrix.length}`);
    console.log(`   Total combinations: ${totalCombinations}`);
    console.log(`   Total test runs: ${totalRuns}`);
    console.log();

    // Show the matrix structure
    console.log('🎯 Matrix Structure:');
    config.matrix.forEach((axis, index) => {
        console.log(`   Axis ${index + 1}: ${axis.parameter}`);
        console.log(`     Values: [${axis.values.map(v => JSON.stringify(v)).join(', ')}]`);
        console.log(`     Count: ${axis.values.length}`);
    });
    console.log();

    // Generate and show all combinations
    console.log('🔀 All Parameter Combinations:');
    const combinations = generateParameterCombinations(config);
    combinations.forEach((combo, index) => {
        console.log(`   ${index + 1}. ${JSON.stringify(combo, null, 0)}`);
    });
    console.log();

    console.log('🎉 Demo completed successfully!');
    console.log();
    console.log('📝 What this shows:');
    console.log('   ✅ YAML parsing works');
    console.log('   ✅ Schema validation works');
    console.log('   ✅ Parameter combination generation works');
    console.log('   ✅ All utilities work as expected');
    console.log();
    console.log('🚀 Ready for tickets #5779 and #5780 to implement:');
    console.log('   - elizaos scenario matrix command');
    console.log('   - Parameter override system');
    console.log('   - Actual test execution');

} catch (error) {
    console.error('❌ Demo failed:', error);
    process.exit(1);
}
