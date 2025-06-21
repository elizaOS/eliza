import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/test-runner.ts'],
  format: ['esm'],
  dts: false, // Temporarily disabled due to TypeScript project references issue
  sourcemap: true,
  clean: true,
  splitting: false,
  minify: false,
  esbuildOptions(options) {
    options.resolveExtensions = ['.ts', '.js'];
  },
  external: [
    '@elizaos/core',
    '@elizaos/plugin-sql',
    '@elizaos/plugin-github',
    '@elizaos/plugin-todo',
    '@elizaos/plugin-trust',
    '@elizaos/plugin-rolodex',
    '@elizaos/plugin-planning',
    '@elizaos/plugin-research',
    '@elizaos/plugin-knowledge',
    '@elizaos/plugin-solana',
    '@elizaos/plugin-evm',
    '@elizaos/plugin-payment',
    '@elizaos/plugin-secrets-manager',
    '@elizaos/plugin-plugin-manager',
    '@elizaos/plugin-stagehand',
    '@elizaos/plugin-agentkit',
    '@elizaos/plugin-autocoder',
    '@elizaos/plugin-auton8n',
    '@elizaos/plugin-autonomy',
    '@elizaos/plugin-goals',
    '@elizaos/plugin-mcp',
    '@elizaos/plugin-ngrok',
    '@elizaos/plugin-tasks'
  ],
  bundle: false,
  target: 'es2022',
  outDir: 'dist'
});