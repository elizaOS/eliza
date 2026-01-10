import type { TestSuite, IAgentRuntime } from '@elizaos/core';
import { PluginCreationService, PluginSpecification } from '../services/plugin-creation-service.ts';
import fs from 'fs-extra';
import path from 'path';

// Time plugin specification
const TIME_PLUGIN_SPEC: PluginSpecification = {
  name: '@elizaos/plugin-time',
  description: 'Provides current time and timezone information',
  version: '1.0.0',
  actions: [
    {
      name: 'getCurrentTime',
      description: 'Get current time in any timezone',
      parameters: {
        timezone: 'string',
      },
    },
    {
      name: 'convertTime',
      description: 'Convert time between timezones',
      parameters: {
        time: 'string',
        fromTimezone: 'string',
        toTimezone: 'string',
      },
    },
  ],
  providers: [
    {
      name: 'timeProvider',
      description: 'Provides current time context',
      dataStructure: {
        currentTime: 'string',
        timezone: 'string',
        utcOffset: 'number',
      },
    },
  ],
};

export class TimePluginE2ETestSuite implements TestSuite {
  name = 'plugin-auton8n-time-e2e';
  description = 'End-to-end tests for TIME plugin creation with real runtime';

  tests = [
    {
      name: 'Should create TIME plugin with real Anthropic API',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing TIME plugin creation with real runtime...');

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
        const jobId = await service.createPlugin(TIME_PLUGIN_SPEC, apiKey);
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
            console.log(`   Last log: ${lastLog}`);
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
          console.error('Logs:', job.logs.join('\n'));
          throw new Error(`Plugin creation failed: ${job.error || 'Unknown error'}`);
        }

        console.log('✓ Plugin created successfully!');

        // Verify the plugin was created on disk
        const pluginPath = job.outputPath;
        if (!(await fs.pathExists(pluginPath))) {
          throw new Error('Plugin directory not created');
        }

        // Verify key files exist
        const requiredFiles = [
          'package.json',
          'src/index.ts',
          'src/actions/getCurrentTime.ts',
          'src/actions/convertTime.ts',
          'src/providers/timeProvider.ts',
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
        if (packageJson.name !== TIME_PLUGIN_SPEC.name) {
          throw new Error(
            `Package name mismatch: expected ${TIME_PLUGIN_SPEC.name}, got ${packageJson.name}`
          );
        }

        console.log('✓ Package.json validated');
        console.log(`✓ Plugin location: ${pluginPath}`);

        // Clean up after test
        console.log('Cleaning up test plugin...');
        await fs.remove(pluginPath);
        console.log('✓ Cleanup complete');

        console.log('✓ TIME plugin e2e test completed successfully!');
      },
    },
    {
      name: 'Should track TIME plugin in registry',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing plugin registry tracking...');

        const service = runtime.services.get('plugin_creation' as any) as PluginCreationService;
        if (!service) {
          throw new Error('Plugin creation service not available');
        }

        // Check if plugin is tracked
        const isCreated = service.isPluginCreated(TIME_PLUGIN_SPEC.name);
        const createdPlugins = service.getCreatedPlugins();

        console.log(`✓ TIME plugin tracked: ${isCreated}`);
        console.log(`✓ Total plugins in registry: ${createdPlugins.length}`);

        if (isCreated && !createdPlugins.includes(TIME_PLUGIN_SPEC.name)) {
          throw new Error('Registry inconsistency detected');
        }

        console.log('✓ Plugin registry test passed');
      },
    },
  ];
}

export default new TimePluginE2ETestSuite();
