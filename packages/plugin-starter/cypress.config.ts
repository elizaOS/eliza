import { defineConfig } from 'cypress';

export default defineConfig({
  component: {
    devServer: {
      framework: 'react',
      bundler: 'vite',
    },
    specPattern: 'src/__tests__/cypress/component/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: 'src/__tests__/cypress/support/component.ts',
    indexHtmlFile: 'src/__tests__/cypress/support/component-index.html',
  },
  e2e: {
    baseUrl: 'http://localhost:3000',
    supportFile: 'src/__tests__/cypress/support/e2e.ts',
    specPattern: 'src/__tests__/cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
  },
});
