import type { IAgentRuntime, TestCase, TestSuite } from '@elizaos/core';
import { tunnelAction } from '../actions/tunnel';
import { tunnelStateProvider } from '../providers/tunnel-state';
import { LocalTunnelService } from '../services/LocalTunnelService';

export class TunnelTestSuite implements TestSuite {
  name = 'tunnel';
  tests: TestCase[] = [
    {
      name: 'LocalTunnelService — service-type contract',
      fn: (_runtime: IAgentRuntime) => {
        if (LocalTunnelService.serviceType !== 'tunnel') {
          throw new Error('LocalTunnelService.serviceType must be "tunnel"');
        }
      },
    },
    {
      name: 'tunnelAction — name and op enum',
      fn: (_runtime: IAgentRuntime) => {
        if (tunnelAction.name !== 'TUNNEL') {
          throw new Error(`tunnelAction.name must be "TUNNEL", got ${tunnelAction.name}`);
        }
        const opParam = tunnelAction.parameters?.find((p) => p.name === 'op');
        if (!opParam) throw new Error('tunnelAction must declare an `op` parameter');
        const enumVals = (opParam.schema as { enum?: unknown[] } | undefined)?.enum;
        if (!Array.isArray(enumVals)) throw new Error('op parameter must declare a string enum');
        for (const expected of ['start', 'stop', 'status']) {
          if (!enumVals.includes(expected)) {
            throw new Error(`op enum missing "${expected}"`);
          }
        }
      },
    },
    {
      name: 'TUNNEL_STATE provider — name and shape',
      fn: (_runtime: IAgentRuntime) => {
        if (tunnelStateProvider.name !== 'TUNNEL_STATE') {
          throw new Error(`tunnelStateProvider.name must be "TUNNEL_STATE"`);
        }
        if (typeof tunnelStateProvider.get !== 'function') {
          throw new Error('tunnelStateProvider must define get()');
        }
      },
    },
  ];
}
