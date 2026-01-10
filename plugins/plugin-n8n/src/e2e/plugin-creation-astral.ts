import type { TestSuite, IAgentRuntime } from '@elizaos/core';
import { PluginCreationService, PluginSpecification } from '../services/plugin-creation-service.ts';
import fs from 'fs-extra';
import path from 'path';

// Astral chart plugin specification with external dependencies
const ASTRAL_CHART_SPEC: PluginSpecification = {
  name: '@elizaos/plugin-astral',
  description: 'Calculate astral charts using astronomical algorithms',
  version: '1.0.0',
  actions: [
    {
      name: 'calculateChart',
      description: 'Calculate natal chart for given birth data',
      parameters: {
        birthDate: 'string',
        birthTime: 'string',
        latitude: 'number',
        longitude: 'number',
      },
    },
    {
      name: 'getPlanetPositions',
      description: 'Get current planetary positions',
      parameters: {
        date: 'string',
        observer: {
          latitude: 'number',
          longitude: 'number',
        },
      },
    },
  ],
  dependencies: {
    astronomia: '^4.1.1',
  },
};

export class AstralPluginE2ETestSuite implements TestSuite {
  name = 'plugin-auton8n-astral-e2e';
  description = 'End-to-end tests for ASTRAL plugin creation with dependencies';

  tests = [
    {
      name: 'Should create ASTRAL plugin with external dependencies',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing ASTRAL plugin creation with dependencies...');

        // Get the service from runtime
        const service = runtime.services.get('plugin_creation' as any) as PluginCreationService;
        if (!service) {
          throw new Error('Plugin creation service not available');
        }

        // Check if API key is available
        const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');
        if (!apiKey) {
          console.log('⚠️  Skipping test: ANTHROPIC_API_KEY not configured');
          console.log('   Set ANTHROPIC_API_KEY environment variable to run this test');
          return;
        }

        console.log('✓ API key available, proceeding with plugin creation...');

        // Create the plugin
        const jobId = await service.createPlugin(ASTRAL_CHART_SPEC, apiKey);
        console.log(`✓ Plugin creation job started: ${jobId}`);

        // Wait for completion (with timeout)
        const startTime = Date.now();
        const timeout = 5 * 60 * 1000; // 5 minutes
        let job = service.getJobStatus(jobId);

        while (job && ['pending', 'running'].includes(job.status)) {
          if (Date.now() - startTime > timeout) {
            throw new Error('Plugin creation timed out after 5 minutes');
          }

          // Log progress
          if (job.logs.length > 0) {
            const lastLog = job.logs[job.logs.length - 1];
            console.log(`   Status: ${job.status}, Phase: ${job.currentPhase}`);
            console.log(`   Progress: ${job.progress}%`);
          }

          // Wait before checking again
          await new Promise((resolve) => setTimeout(resolve, 2000));
          job = service.getJobStatus(jobId);
        }

        if (!job) {
          throw new Error('Job disappeared unexpectedly');
        }

        // Check final status
        if (job.status !== 'completed') {
          console.error('Job failed with status:', job.status);
          console.error('Error:', job.error);
          console.error('Last 10 logs:');
          job.logs.slice(-10).forEach((log) => console.error(log));
          throw new Error(`Plugin creation failed: ${job.error || 'Unknown error'}`);
        }

        console.log('✓ Plugin created successfully!');
        console.log(`  Model used: ${job.modelUsed}`);
        console.log(`  Iterations: ${job.currentIteration}/${job.maxIterations}`);

        // Verify the plugin was created on disk
        const pluginPath = job.outputPath;
        if (!(await fs.pathExists(pluginPath))) {
          throw new Error('Plugin directory not created');
        }

        // Verify key files exist
        const requiredFiles = [
          'package.json',
          'src/index.ts',
          'src/actions/calculateChart.ts',
          'src/actions/getPlanetPositions.ts',
        ];

        for (const file of requiredFiles) {
          const filePath = path.join(pluginPath, file);
          if (!(await fs.pathExists(filePath))) {
            throw new Error(`Required file missing: ${file}`);
          }
          console.log(`✓ Found ${file}`);
        }

        // Verify package.json content
        const packageJson = await fs.readJson(path.join(pluginPath, 'package.json'));
        if (packageJson.name !== ASTRAL_CHART_SPEC.name) {
          throw new Error(
            `Package name mismatch: expected ${ASTRAL_CHART_SPEC.name}, got ${packageJson.name}`
          );
        }

        // Verify dependencies were added
        if (!packageJson.dependencies || !packageJson.dependencies.astronomia) {
          throw new Error('External dependency astronomia not added to package.json');
        }

        console.log('✓ Package.json validated with dependencies');
        console.log(`✓ Dependencies: ${JSON.stringify(packageJson.dependencies)}`);

        // Verify the actions have proper implementation
        const calculateChartContent = await fs.readFile(
          path.join(pluginPath, 'src/actions/calculateChart.ts'),
          'utf-8'
        );

        if (
          calculateChartContent.includes('TODO') ||
          calculateChartContent.includes('Not implemented')
        ) {
          console.warn('⚠️  Action contains TODO or stub implementation');
        }

        // Check validation score if available
        if (job.validationScore) {
          console.log(`✓ Validation score: ${job.validationScore}/100`);
          if (job.validationScore < 70) {
            console.warn('⚠️  Low validation score, plugin may need improvements');
          }
        }

        console.log(`✓ Plugin location: ${pluginPath}`);

        // Clean up after test
        console.log('Cleaning up test plugin...');
        await fs.remove(pluginPath);
        console.log('✓ Cleanup complete');

        console.log('✓ ASTRAL plugin e2e test completed successfully!');
      },
    },
    {
      name: 'Should prevent duplicate ASTRAL plugin creation',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing duplicate plugin prevention...');

        const service = runtime.services.get('plugin_creation' as any) as PluginCreationService;
        if (!service) {
          throw new Error('Plugin creation service not available');
        }

        const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');
        if (!apiKey) {
          console.log('⚠️  Skipping test: ANTHROPIC_API_KEY not configured');
          return;
        }

        // Try to create duplicate plugin
        try {
          await service.createPlugin(ASTRAL_CHART_SPEC, apiKey);
          throw new Error('Expected duplicate creation to fail');
        } catch (error) {
          if (error.message.includes('already been created')) {
            console.log('✓ Duplicate plugin creation properly prevented');
          } else {
            throw error;
          }
        }
      },
    },
  ];
}

export default new AstralPluginE2ETestSuite();
