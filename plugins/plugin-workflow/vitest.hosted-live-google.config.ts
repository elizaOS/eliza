import { defineConfig } from 'vitest/config';
import { buildWorkspaceSourceAliases } from '../../packages/scripts/vitest/source-aliases.ts';
export default defineConfig({
  resolve: { conditions: ['eliza-source', 'node'], alias: buildWorkspaceSourceAliases() },
  test: {
    environment: 'node',
    include: ['__tests__/integration/hosted-live-google-http.test.ts'],
    testTimeout: 240000,
    hookTimeout: 120000,
  },
});
