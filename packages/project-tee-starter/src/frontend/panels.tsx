import type { Route } from '@elizaos/core';

/**
 * Export panel routes for TEE status visualization
 */
export const panels: Route[] = [
  {
    type: 'GET',
    path: '/public/tee-status',
    name: 'TEE Status',
    public: true,
    handler: async (req: any, res: any, runtime: any) => {
      // Serve the TEE status panel
      res.sendFile('index.html', { root: 'dist/frontend' });
    },
  },
];
