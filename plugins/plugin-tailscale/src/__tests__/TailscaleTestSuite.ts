import type { IAgentRuntime, TestCase, TestSuite } from '@elizaos/core';
import { LocalTailscaleService } from '../services/LocalTailscaleService';
import { CloudTailscaleService } from '../services/CloudTailscaleService';

export class TailscaleTestSuite implements TestSuite {
  name = 'tailscale';
  tests: TestCase[] = [
    {
      name: 'LocalTailscaleService — service-type contract',
      fn: (_runtime: IAgentRuntime) => {
        if (LocalTailscaleService.serviceType !== 'tunnel') {
          throw new Error('LocalTailscaleService.serviceType must be "tunnel"');
        }
      },
    },
    {
      name: 'CloudTailscaleService — service-type contract',
      fn: (_runtime: IAgentRuntime) => {
        if (CloudTailscaleService.serviceType !== 'tunnel') {
          throw new Error('CloudTailscaleService.serviceType must be "tunnel"');
        }
      },
    },
  ];
}
