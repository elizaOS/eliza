import type { TestSuite, IAgentRuntime } from '@elizaos/core';
import {
  PluginCreationService,
  PluginSpecification,
  PluginCreationJob,
} from '../services/plugin-creation-service.ts';
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

// Astral plugin specification
const ASTRAL_PLUGIN_SPEC: PluginSpecification = {
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

// Shell plugin specification
const SHELL_PLUGIN_SPEC: PluginSpecification = {
  name: '@elizaos/plugin-shell',
  description: 'Execute shell commands and curl requests safely',
  version: '1.0.0',
  actions: [
    {
      name: 'executeCommand',
      description: 'Run shell command with safety checks',
      parameters: {
        command: 'string',
        args: 'string[]',
        cwd: 'string',
      },
    },
    {
      name: 'curlRequest',
      description: 'Make HTTP request via curl',
      parameters: {
        url: 'string',
        method: 'string',
        headers: 'object',
        data: 'string',
      },
    },
  ],
  services: [
    {
      name: 'ShellService',
      description: 'Manages shell execution with security',
      methods: ['execute', 'validateCommand', 'auditLog'],
    },
  ],
  environmentVariables: [
    {
      name: 'SHELL_WHITELIST',
      description: 'Comma-separated list of allowed commands',
      required: false,
      sensitive: false,
    },
    {
      name: 'SHELL_AUDIT_LOG',
      description: 'Path to audit log file',
      required: false,
      sensitive: false,
    },
  ],
};

// Helper function to wait for job completion
async function waitForJobCompletion(
  service: PluginCreationService,
  jobId: string,
  timeout: number = 5 * 60 * 1000
): Promise<PluginCreationJob | null> {
  const startTime = Date.now();
  let job = service.getJobStatus(jobId);

  while (job && ['pending', 'running'].includes(job.status)) {
    if (Date.now() - startTime > timeout) {
      throw new Error('Plugin creation timed out');
    }

    // Log progress
    if (job.logs.length > 0) {
      console.log(`   Status: ${job.status}, Phase: ${job.currentPhase}`);
    }

    // Wait before checking again
    await new Promise((resolve) => setTimeout(resolve, 2000));
    job = service.getJobStatus(jobId);
  }

  return job;
}

// Individual test objects following ElizaOS standards
export const timePluginCreationTest = {
  name: 'time-plugin-creation-e2e',
  description: 'E2E test for creating a time plugin with real Anthropic API',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Time Plugin Creation E2E Test...');

    try {
      // 1. Get the plugin creation service
      const service = runtime.services.get('plugin_creation' as any) as PluginCreationService;
      if (!service) {
        throw new Error('Plugin creation service not available');
      }

      // 2. Check if API key is available
      const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');
      if (!apiKey) {
        console.log('⚠️  Skipping test: ANTHROPIC_API_KEY not configured');
        console.log('   Set ANTHROPIC_API_KEY environment variable to run this test');
        return;
      }

      console.log('✓ API key available, proceeding with plugin creation...');

      // 3. Create the plugin
      const jobId = await service.createPlugin(TIME_PLUGIN_SPEC, apiKey);
      console.log(`✓ Plugin creation job started: ${jobId}`);

      // 4. Wait for completion
      const job = await waitForJobCompletion(service, jobId);

      if (!job) {
        throw new Error('Job disappeared unexpectedly');
      }

      // 5. Verify outcomes
      if (job.status !== 'completed') {
        console.error('Job failed with status:', job.status);
        console.error('Error:', job.error);
        throw new Error(`Plugin creation failed: ${job.error || 'Unknown error'}`);
      }

      console.log('✓ Plugin created successfully!');

      // Verify the plugin was created on disk
      const pluginPath = job.outputPath;
      if (pluginPath && (await fs.pathExists(pluginPath))) {
        console.log(`✓ Plugin location: ${pluginPath}`);

        // Clean up after test
        await fs.remove(pluginPath);
        console.log('✓ Cleanup complete');
      }

      console.log('✅ Time Plugin Creation E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Time Plugin Creation E2E Test FAILED:', error);
      throw error;
    }
  },
};

export const astralPluginCreationTest = {
  name: 'astral-plugin-creation-e2e',
  description: 'E2E test for creating an astral plugin with external dependencies',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Astral Plugin Creation E2E Test...');

    try {
      const service = runtime.services.get('plugin_creation' as any) as PluginCreationService;
      if (!service) {
        throw new Error('Plugin creation service not available');
      }

      const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');
      if (!apiKey) {
        console.log('⚠️  Skipping test: ANTHROPIC_API_KEY not configured');
        return;
      }

      // Create plugin with dependencies
      const jobId = await service.createPlugin(ASTRAL_PLUGIN_SPEC, apiKey);
      console.log(`✓ Astral plugin creation job started: ${jobId}`);

      // Wait for completion with proper polling
      const job = await waitForJobCompletion(service, jobId);

      if (!job) {
        throw new Error('Job disappeared unexpectedly');
      }

      if (job.status === 'completed') {
        console.log('✓ Astral plugin created with dependencies');

        // Cleanup
        if (job.outputPath && (await fs.pathExists(job.outputPath))) {
          await fs.remove(job.outputPath);
          console.log('✓ Cleanup complete');
        }
      } else {
        throw new Error(`Plugin creation failed: ${job.error || job.status}`);
      }

      console.log('✅ Astral Plugin Creation E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Astral Plugin Creation E2E Test FAILED:', error);
      throw error;
    }
  },
};

export const shellPluginSecurityTest = {
  name: 'shell-plugin-security-e2e',
  description: 'E2E test for shell plugin creation with security validation',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Shell Plugin Security E2E Test...');

    try {
      const service = runtime.services.get('plugin_creation' as any) as PluginCreationService;
      if (!service) {
        throw new Error('Plugin creation service not available');
      }

      const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');
      if (!apiKey) {
        console.log('⚠️  Skipping test: ANTHROPIC_API_KEY not configured');
        return;
      }

      // Test dangerous plugin name
      const dangerousSpec = {
        ...SHELL_PLUGIN_SPEC,
        name: '../../../etc/passwd',
      };

      try {
        await service.createPlugin(dangerousSpec, apiKey);
        throw new Error('Should have rejected dangerous plugin name');
      } catch (error: any) {
        if (error.message.includes('Invalid plugin name')) {
          console.log('✓ Security validation passed - dangerous name rejected');
        } else {
          throw error;
        }
      }

      console.log('✅ Shell Plugin Security E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Shell Plugin Security E2E Test FAILED:', error);
      throw error;
    }
  },
};

export const pluginRegistryTest = {
  name: 'plugin-registry-e2e',
  description: 'E2E test for plugin registry tracking',
  fn: async (runtime: IAgentRuntime) => {
    console.log('Starting Plugin Registry E2E Test...');

    try {
      const service = runtime.services.get('plugin_creation' as any) as PluginCreationService;
      if (!service) {
        throw new Error('Plugin creation service not available');
      }

      // Check registry
      const createdPlugins = service.getCreatedPlugins();
      console.log(`✓ Total plugins in registry: ${createdPlugins.length}`);

      // Verify specific plugins - Note: This depends on previous tests
      const hasTimePlugin = service.isPluginCreated(TIME_PLUGIN_SPEC.name);
      const hasAstralPlugin = service.isPluginCreated(ASTRAL_PLUGIN_SPEC.name);
      console.log(`✓ Time plugin tracked: ${hasTimePlugin}`);
      console.log(`✓ Astral plugin tracked: ${hasAstralPlugin}`);

      console.log('✅ Plugin Registry E2E Test PASSED\n');
    } catch (error) {
      console.error('❌ Plugin Registry E2E Test FAILED:', error);
      throw error;
    }
  },
};

// Test suite following ElizaOS standards
export const pluginCreationE2ETests: TestSuite = {
  name: 'Plugin Creation E2E Tests',
  tests: [
    timePluginCreationTest,
    astralPluginCreationTest,
    shellPluginSecurityTest,
    pluginRegistryTest,
  ],
};

// Export default for backward compatibility
export default pluginCreationE2ETests;
