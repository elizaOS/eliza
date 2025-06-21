// import path from 'node:path'; // Available for path operations if needed

export function createVitestConfig(_targetPath: string, pluginName?: string): any {
  const config: any = {
    test: {
      globals: true,
      environment: 'node',
      testTimeout: 30000,
      hookTimeout: 30000,
      teardownTimeout: 10000,
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
      include: [],
      exclude: [],
    },
  };

  if (pluginName) {
    // For plugin testing, only include tests from the specific plugin
    config.test.include = [`src/__tests__/**/*.ts`, `src/**/*.test.ts`];

    config.test.exclude = ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/coverage/**'];
  } else {
    // For project testing
    config.test.include = ['**/*.test.{js,ts}', '**/*.spec.{js,ts}'];
    config.test.exclude = ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/coverage/**'];
  }

  return config;
}
