import { defineConfig } from 'vitest/config';
import { buildWorkspaceSourceAliases } from '../../packages/scripts/vitest/source-aliases.ts';
export default defineConfig({resolve:{conditions:['eliza-source','node'],alias:buildWorkspaceSourceAliases()},test:{environment:'node',include:['__tests__/cloud-google-delegation.http.test.ts'],testTimeout:120000,hookTimeout:120000}});
