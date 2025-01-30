import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Enable Jest-like globals (describe, it, expect)
    globals: true,
    
    // Environment setup
    environment: 'node',
    
    // Test file patterns
    include: ['__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    
    // TypeScript configuration
    typecheck: {
      tsconfig: './tsconfig.json',
      include: ['**/*.{test,spec}.{ts,tsx}'],
    },
  },
});
