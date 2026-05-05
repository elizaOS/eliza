import type { IAgentRuntime, TestCase, TestSuite } from '@elizaos/core';
import { LocalTailscaleService } from '../services/LocalTailscaleService';
import { CloudTailscaleService } from '../services/CloudTailscaleService';
import { TAILSCALE_CLOUD_TUNNEL_SERVICE_TYPE, TAILSCALE_LOCAL_TUNNEL_SERVICE_TYPE } from '../types';

export class TailscaleTestSuite implements TestSuite {
  name = 'tailscale';
  tests: TestCase[] = [
    {
      name: 'LocalTailscaleService service-type contract',
      fn: (_runtime: IAgentRuntime) => {
        if (LocalTailscaleService.serviceType !== TAILSCALE_LOCAL_TUNNEL_SERVICE_TYPE) {
          throw new Error(
            `LocalTailscaleService.serviceType must be "${TAILSCALE_LOCAL_TUNNEL_SERVICE_TYPE}"`,
          );
        }
      },
    },
    {
      name: 'CloudTailscaleService service-type contract',
      fn: (_runtime: IAgentRuntime) => {
        if (CloudTailscaleService.serviceType !== TAILSCALE_CLOUD_TUNNEL_SERVICE_TYPE) {
          throw new Error(
            `CloudTailscaleService.serviceType must be "${TAILSCALE_CLOUD_TUNNEL_SERVICE_TYPE}"`,
          );
        }
      },
    },
  ];
}
