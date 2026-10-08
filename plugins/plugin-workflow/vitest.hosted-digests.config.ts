import { defineConfig } from 'vitest/config';
import { buildWorkspaceSourceAliases } from '../../packages/scripts/vitest/source-aliases.ts';
export default defineConfig({
  resolve: { conditions: ['eliza-source', 'node'], alias: buildWorkspaceSourceAliases() },
  test: {
    environment: 'node',
    include: [
      '__tests__/integration/hosted-digests-http.test.ts',
      '__tests__/integration/hosted-native-source-http.test.ts',
    ],
    testTimeout: 240000,
    hookTimeout: 120000,
  },
});
