import { defineConfig } from 'cypress';
import viteConfig from './vite.config';

export default defineConfig({
  component: {
    devServer: {
      framework: 'react',
      bundler: 'vite',
      viteConfig,
    },
    specPattern: 'src/__tests__/cypress/component/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: 'src/__tests__/cypress/support/component.ts',
    indexHtmlFile: 'src/__tests__/cypress/support/component-index.html',
  },
  e2e: {
    baseUrl: 'http://localhost:3000',
    specPattern: 'src/__tests__/cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: 'src/__tests__/cypress/support/e2e.ts',
    viewportWidth: 1280,
    viewportHeight: 720,
    defaultCommandTimeout: 10000,
    requestTimeout: 10000,
    responseTimeout: 10000,
  },
  video: false,
  screenshotOnRunFailure: true,
  screenshotsFolder: 'cypress/screenshots',
  videosFolder: 'cypress/videos',
  viewportWidth: 1280,
  viewportHeight: 720,
});
