import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
    },
    resolve: {
        alias: [
            {
                find: /^@elizaos\/core$/,
                replacement: '../core/src/index.ts'
            },
            {
                find: /^ai-agent-sdk-js$/,
                replacement: '../node_modules/ai-agent-sdk-js/src/index.ts'
            }
        ]
    }
});
