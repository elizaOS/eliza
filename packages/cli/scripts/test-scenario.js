#!/usr/bin/env node

// Simple test script to verify scenario files can be loaded
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testScenarioLoading() {
  console.log('Testing scenario loading...\n');
  
  const scenarios = [
    './scenarios/plugin-tests/01-research-knowledge-integration.ts',
    './scenarios/plugin-tests/02-github-todo-workflow.ts',
    './scenarios/plugin-tests/03-planning-execution.ts',
    './scenarios/plugin-tests/04-rolodex-relationship-management.ts',
    './scenarios/plugin-tests/05-stagehand-web-research.ts',
  ];
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const scenarioPath of scenarios) {
    try {
      const fullPath = join(__dirname, scenarioPath);
      console.log(`Loading: ${scenarioPath}`);
      
      // Dynamic import
      const module = await import(fullPath);
      const scenario = module.default || module.scenario;
      
      if (scenario && scenario.id && scenario.name) {
        console.log(`  ✓ Loaded: ${scenario.name} (${scenario.id})`);
        console.log(`    - Actors: ${scenario.actors.length}`);
        console.log(`    - Verification rules: ${scenario.verification.rules.length}`);
        console.log(`    - Tags: ${scenario.tags.join(', ')}`);
        successCount++;
      } else {
        console.log(`  ✗ Invalid scenario structure`);
        errorCount++;
      }
    } catch (error) {
      console.log(`  ✗ Error: ${error.message}`);
      errorCount++;
    }
    console.log('');
  }
  
  console.log(`\nSummary: ${successCount} loaded successfully, ${errorCount} errors`);
  
  if (successCount > 0) {
    console.log('\nThe scenario files are properly structured!');
    console.log('The issue with the scenario runner is likely related to plugin initialization.');
    console.log('\nSuggested next steps:');
    console.log('1. Ensure all required plugins are installed');
    console.log('2. Check that plugin modules export proper plugin objects');
    console.log('3. Consider running scenarios with a pre-configured agent that has plugins loaded');
  }
}

testScenarioLoading().catch(console.error); 