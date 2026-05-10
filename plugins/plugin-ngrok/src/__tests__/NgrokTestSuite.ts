import type { IAgentRuntime, TestCase } from '@elizaos/core';
import { NgrokService } from '../services/NgrokService';

export class NgrokTestSuite {
  name = 'ngrok';
  tests: TestCase[] = [
    {
      name: 'Initialize Ngrok Service',
      fn: async (runtime: IAgentRuntime) => {
        // Test service initialization
        const service = new NgrokService(runtime);

        // Verify service is initialized
        if (!service) {
          throw new Error('Failed to initialize Ngrok service');
        }

        if (!(service instanceof NgrokService)) {
          throw new Error('Service is not instance of NgrokService');
        }
      },
    },
    {
      name: 'Start and Stop Tunnel',
      fn: async (runtime: IAgentRuntime) => {
        const service = new NgrokService(runtime);

        // Test starting tunnel
        const url = await service.startTunnel(3000);

        if (!url?.startsWith('https://')) {
          throw new Error('Failed to start tunnel or invalid URL returned');
        }

        // Verify tunnel is active
        if (!service.isActive()) {
          throw new Error('Tunnel should be active after starting');
        }

        // Test getting status
        const status = service.getStatus();
        if (!status.active || status.port !== 3000) {
          throw new Error('Invalid tunnel status');
        }

        // Test stopping tunnel
        await service.stopTunnel();

        // Verify tunnel is stopped
        if (service.isActive()) {
          throw new Error('Tunnel should not be active after stopping');
        }
      },
    },
    {
      name: 'Service Registration',
      fn: async (runtime: IAgentRuntime) => {
        // Test that service can be registered and retrieved
        const _service = new NgrokService(runtime);

        // In a real test, we would register the service with runtime
        // and then retrieve it to verify registration
        const serviceType = NgrokService.serviceType;
        if (serviceType !== 'tunnel') {
          throw new Error('Service type should be "tunnel"');
        }
      },
    },
    {
      name: 'Tunnel Status When Inactive',
      fn: async (runtime: IAgentRuntime) => {
        const service = new NgrokService(runtime);

        // Get status when tunnel is not active
        const status = service.getStatus();

        if (status.active) {
          throw new Error('Tunnel should not be active initially');
        }

        if (status.url !== null || status.port !== null) {
          throw new Error('URL and port should be null when inactive');
        }

        if (status.provider !== 'ngrok') {
          throw new Error('Provider should always be "ngrok"');
        }
      },
    },
    {
      name: 'Multiple Start Attempts',
      fn: async (runtime: IAgentRuntime) => {
        const service = new NgrokService(runtime);

        // Start tunnel
        const url1 = await service.startTunnel(3000);

        // Try to start again (should return same URL)
        const url2 = await service.startTunnel(3000);

        if (url1 !== url2) {
          throw new Error('Starting tunnel twice should return the same URL');
        }

        // Clean up
        await service.stopTunnel();
      },
    },
  ];
}
