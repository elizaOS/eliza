const { defineConfig } = require('cypress');
const path = require('path');

module.exports = defineConfig({
  // E2E Testing Configuration
  e2e: {
    baseUrl: 'http://localhost:5173',
    specPattern: 'cypress/e2e/**/*.{cy,spec}.{js,ts,jsx,tsx}',
    supportFile: 'cypress/support/e2e.ts',
    video: false,
    screenshotOnRunFailure: true,
    viewportWidth: 1280,
    viewportHeight: 720,
    defaultCommandTimeout: 10000,
    requestTimeout: 10000,
    responseTimeout: 10000,
    setupNodeEvents(on, config) {
      // Add any e2e specific plugins here
      return config;
    },
  },

  // Component Testing Configuration
  component: {
    specPattern: 'src/**/*.cy.{js,ts,jsx,tsx}',
    supportFile: 'cypress/support/component.ts',
    indexHtmlFile: 'cypress/support/component-index.html',
    devServer: {
      framework: 'react',
      bundler: 'vite',
      viteConfig: {
        configFile: path.resolve(__dirname, 'vite.config.cypress.ts'),
      },
    },
    video: false,
    screenshotOnRunFailure: true,
    viewportWidth: 1280,
    viewportHeight: 720,
  },

  // Global Configuration
  projectId: 'elizaos-client',
  chromeWebSecurity: false,
  redirectionLimit: 100, // Increase redirect limit for E2E tests with infinite redirect issue
  retries: {
    runMode: 2,
    openMode: 0,
  },
  watchForFileChanges: true,

  // Environment variables
  env: {
    SERVER_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:3000/api',
    WS_URL: 'ws://localhost:3000',
  },
});
