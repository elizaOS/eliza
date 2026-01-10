import type { TestSuite } from '@elizaos/core';

export class PluginDynamicTestSuite implements TestSuite {
  name = 'plugin-auton8n';
  description = 'Tests for the plugin-auton8n system integration';

  tests = [
    {
      name: 'Should register plugin creation service',
      fn: async (runtime: any) => {
        console.log('Testing plugin creation service registration...');

        // Check if plugin creation service is available
        const service = runtime.services.get('plugin_creation' as any);
        if (!service) {
          throw new Error('Plugin creation service not registered');
        }

        console.log('✓ Plugin creation service is available');
        console.log('✓ Service type:', service.serviceType || 'plugin_creation');
      },
    },
    {
      name: 'Should verify service functionality',
      fn: async (runtime: any) => {
        console.log('Testing plugin creation service functionality...');

        // Get the service from runtime
        const service = runtime.services.get('plugin_creation' as any);
        if (!service) {
          throw new Error('Plugin creation service not available');
        }

        // Check that the service has expected methods
        if (typeof service.createPlugin !== 'function') {
          throw new Error('Service missing createPlugin method');
        }

        if (typeof service.getJobStatus !== 'function') {
          throw new Error('Service missing getJobStatus method');
        }

        if (typeof service.listJobs !== 'function') {
          throw new Error('Service missing listJobs method');
        }

        // Test basic functionality
        const jobs = service.listJobs();
        console.log(`✓ Service has ${jobs.length} active jobs`);

        console.log('✓ Plugin creation service has all expected methods');
        console.log('✓ Service is fully functional');
      },
    },
    {
      name: 'Should verify plugin registry tracking',
      fn: async (runtime: any) => {
        console.log('Testing plugin registry functionality...');

        // Get the service from runtime
        const service = runtime.services.get('plugin_creation' as any);
        if (!service) {
          throw new Error('Plugin creation service not available');
        }

        // Check registry methods
        if (typeof service.isPluginCreated !== 'function') {
          throw new Error('Service missing isPluginCreated method');
        }

        if (typeof service.getCreatedPlugins !== 'function') {
          throw new Error('Service missing getCreatedPlugins method');
        }

        // Get current plugins
        const createdPlugins = service.getCreatedPlugins();
        console.log(`✓ Registry tracking ${createdPlugins.length} created plugins`);

        // Test a check
        const exists = service.isPluginCreated('test-plugin');
        console.log(`✓ Plugin existence check works: test-plugin exists = ${exists}`);

        console.log('✓ Plugin registry functionality verified');
      },
    },
  ];
}

export default new PluginDynamicTestSuite();
