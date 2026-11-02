import { defineConfig } from 'vitest/config';
import { buildWorkspaceSourceAliases } from '/workspace/packages/scripts/vitest/source-aliases.ts';
export default defineConfig({
 root: '/results/vitest', cacheDir: '/results/cache',
 resolve: { conditions: ['eliza-source', 'node'], alias: buildWorkspaceSourceAliases('/workspace') },
 server: { fs: { allow: ['/workspace', '/results'] } },
 test: { dir: '/workspace', include: ["packages/cloud/api/src/speech-relay-admission.retirement.test.ts", "packages/cloud/api/src/speech-retirement-coordinator.test.ts", "packages/cloud/api/src/speech-retirement-route.test.ts", "packages/cloud/api/src/speech-retirement-state.test.ts", "packages/cloud/api/v1/voice/session/lib/provider-retirement.test.ts", "packages/host/src/voice/cartesia-sonic-retirement.test.ts", "packages/host/src/voice/speech-retirement-session.test.ts"], environment: 'node', pool: 'forks', maxWorkers: 1, fileParallelism: false, testTimeout: 15000, hookTimeout: 20000 },
});
