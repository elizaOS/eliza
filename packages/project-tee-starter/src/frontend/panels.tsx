import type { Route, RouteRequest, RouteResponse, IAgentRuntime } from '@elizaos/core';

/**
 * Export panel routes for TEE status visualization
 */
export const panels: Route[] = [
  {
    type: 'GET',
    path: '/public/tee-status',
    name: 'TEE Status',
    public: true,
    handler: async (_req: RouteRequest, res: RouteResponse, _runtime: IAgentRuntime) => {
      // Serve the TEE status panel
      // Note: sendFile is Express-specific, cast as needed
      (res as any).sendFile('index.html', { root: 'dist/frontend' });
    },
  },
];
