/**
 * Vitest configuration for the declaration-only contracts package.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts'],
		testTimeout: 30_000,
	},
});
