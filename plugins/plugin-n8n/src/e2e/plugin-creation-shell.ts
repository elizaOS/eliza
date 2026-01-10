import type { TestSuite, IAgentRuntime } from '@elizaos/core';
import {
  PluginCreationService,
  PluginSpecification,
  ClaudeModel,
} from '../services/plugin-creation-service.ts';
import fs from 'fs-extra';
import path from 'path';

// Shell command plugin specification with services and security
const SHELL_COMMAND_SPEC: PluginSpecification = {
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

export class ShellPluginE2ETestSuite implements TestSuite {
  name = 'plugin-auton8n-shell-e2e';
  description = 'End-to-end tests for SHELL plugin creation with services and security';

  tests = [
    {
      name: 'Should create SHELL plugin with security features and services',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing SHELL plugin creation with services and security...');

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

        // Use Opus model for complex plugin
        const jobId = await service.createPlugin(SHELL_COMMAND_SPEC, apiKey, {
          model: ClaudeModel.OPUS_3,
        });
        console.log(`✓ Plugin creation job started: ${jobId}`);
        console.log('  Using Claude Opus model for complex plugin generation');

        // Wait for completion (with timeout)
        const startTime = Date.now();
        const timeout = 10 * 60 * 1000; // 10 minutes for complex plugin
        let job = service.getJobStatus(jobId);

        while (job && ['pending', 'running'].includes(job.status)) {
          if (Date.now() - startTime > timeout) {
            throw new Error('Plugin creation timed out after 10 minutes');
          }

          // Log progress
          if (job.logs.length > 0) {
            const lastLog = job.logs[job.logs.length - 1];
            console.log(`   Status: ${job.status}, Phase: ${job.currentPhase}`);
            console.log(
              `   Progress: ${job.progress}%, Iteration: ${job.currentIteration}/${job.maxIterations}`
            );
          }

          // Log any errors encountered
          if (job.errors.length > 0) {
            const lastError = job.errors[job.errors.length - 1];
            console.warn(`   ⚠️  Error in ${lastError.phase}: ${lastError.error}`);
          }

          // Wait before checking again
          await new Promise((resolve) => setTimeout(resolve, 3000));
          job = service.getJobStatus(jobId);
        }

        if (!job) {
          throw new Error('Job disappeared unexpectedly');
        }

        // Check final status
        if (job.status !== 'completed') {
          console.error('Job failed with status:', job.status);
          console.error('Error:', job.error);
          console.error('Errors encountered:');
          job.errors.forEach((e) => console.error(`  - ${e.phase}: ${e.error}`));
          console.error('Last 15 logs:');
          job.logs.slice(-15).forEach((log) => console.error(log));
          throw new Error(`Plugin creation failed: ${job.error || 'Unknown error'}`);
        }

        console.log('✓ Plugin created successfully!');
        console.log(`  Model used: ${job.modelUsed}`);
        console.log(`  Iterations needed: ${job.currentIteration}/${job.maxIterations}`);
        console.log(`  Time taken: ${Math.round((Date.now() - startTime) / 1000)}s`);

        // Verify the plugin was created on disk
        const pluginPath = job.outputPath;
        if (!(await fs.pathExists(pluginPath))) {
          throw new Error('Plugin directory not created');
        }

        // Verify key files exist
        const requiredFiles = [
          'package.json',
          'src/index.ts',
          'src/actions/executeCommand.ts',
          'src/actions/curlRequest.ts',
          'src/services/ShellService.ts',
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
        if (packageJson.name !== SHELL_COMMAND_SPEC.name) {
          throw new Error(
            `Package name mismatch: expected ${SHELL_COMMAND_SPEC.name}, got ${packageJson.name}`
          );
        }

        // Verify environment variables are documented
        if (!packageJson.elizaos || !packageJson.elizaos.environmentVariables) {
          throw new Error('Environment variables not configured in package.json');
        }

        const envVars = packageJson.elizaos.environmentVariables;
        if (!Array.isArray(envVars) || envVars.length !== 2) {
          throw new Error(`Expected 2 environment variables, got ${envVars.length}`);
        }

        console.log('✓ Package.json validated with environment variables');
        console.log(`✓ Environment variables: ${envVars.map((v) => v.name).join(', ')}`);

        // Verify service implementation
        const serviceContent = await fs.readFile(
          path.join(pluginPath, 'src/services/ShellService.ts'),
          'utf-8'
        );

        // Check for security features
        const securityFeatures = ['validateCommand', 'whitelist', 'audit'];

        let securityCount = 0;
        for (const feature of securityFeatures) {
          if (serviceContent.toLowerCase().includes(feature)) {
            securityCount++;
            console.log(`✓ Security feature found: ${feature}`);
          }
        }

        if (securityCount < 2) {
          console.warn('⚠️  Limited security features detected in service implementation');
        }

        // Check test results if available
        if (job.testResults) {
          console.log(
            `✓ Test results: ${job.testResults.passed} passed, ${job.testResults.failed} failed`
          );
          console.log(`  Test duration: ${job.testResults.duration}ms`);
        }

        // Check validation score
        if (job.validationScore) {
          console.log(`✓ Validation score: ${job.validationScore}/100`);
          if (job.validationScore < 80) {
            console.warn('⚠️  Validation score below 80, security features may need review');
          }
        }

        console.log(`✓ Plugin location: ${pluginPath}`);

        // Clean up after test
        console.log('Cleaning up test plugin...');
        await fs.remove(pluginPath);
        console.log('✓ Cleanup complete');

        console.log('✓ SHELL plugin e2e test completed successfully!');
      },
    },
    {
      name: 'Should reject invalid plugin names for security',
      fn: async (runtime: IAgentRuntime) => {
        console.log('Testing security validation for plugin names...');

        const service = runtime.services.get('plugin_creation' as any) as PluginCreationService;
        if (!service) {
          throw new Error('Plugin creation service not available');
        }

        const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');

        // Test dangerous plugin names
        const dangerousSpecs = [
          { ...SHELL_COMMAND_SPEC, name: '../../../etc/passwd' },
          { ...SHELL_COMMAND_SPEC, name: '..\\..\\windows\\system32' },
          { ...SHELL_COMMAND_SPEC, name: 'plugin with spaces' },
          { ...SHELL_COMMAND_SPEC, name: 'plugin;rm -rf /' },
        ];

        for (const spec of dangerousSpecs) {
          try {
            await service.createPlugin(spec, apiKey);
            throw new Error(`Expected rejection of dangerous name: ${spec.name}`);
          } catch (error) {
            if (error.message.includes('Invalid plugin name')) {
              console.log(`✓ Correctly rejected dangerous name: ${spec.name}`);
            } else {
              throw error;
            }
          }
        }

        console.log('✓ All dangerous plugin names properly rejected');
      },
    },
  ];
}

export default new ShellPluginE2ETestSuite();
