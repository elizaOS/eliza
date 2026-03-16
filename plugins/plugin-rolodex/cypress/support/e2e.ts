// ***********************************************************
// This example support/e2e.ts is processed and
// loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************

// Cypress support file for Knowledge plugin tests

// Import commands.ts
import './commands';

// Alternatively you can use CommonJS syntax:
// require('./commands')

// Custom commands for Knowledge plugin testing
declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Navigate to the knowledge panel
       */
      visitKnowledgePanel(): Chainable<void>;

      /**
       * Upload a file to the knowledge base
       */
      uploadKnowledgeFile(fileName: string, content: string, mimeType?: string): Chainable<void>;

      /**
       * Search for knowledge
       */
      searchKnowledge(query: string): Chainable<void>;

      /**
       * Delete a document by title
       */
      deleteDocument(title: string): Chainable<void>;
    }
  }
}

// Prevent TypeScript errors
export {};

// Disable uncaught exception handling for React development warnings
Cypress.on('uncaught:exception', (err, runnable) => {
  // Returning false here prevents Cypress from failing the test
  // on uncaught exceptions, which is useful for React development warnings
  return false;
});
