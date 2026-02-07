// ***********************************************
// This example commands.ts shows you how to
// create various custom commands and overwrite
// existing commands.
//
// For more comprehensive examples of custom
// commands please read more here:
// https://on.cypress.io/custom-commands
// ***********************************************

// Custom command to upload files
Cypress.Commands.add('uploadFile', (selector: string, fileName: string, fileContent: string, mimeType: string = 'text/plain') => {
  cy.get(selector).selectFile({
    contents: Cypress.Buffer.from(fileContent),
    fileName: fileName,
    mimeType: mimeType
  }, { force: true });
});

// Custom command to wait for API response
Cypress.Commands.add('waitForApi', (alias: string, timeout: number = 10000) => {
  cy.wait(alias, { timeout });
});

// Declare custom commands for TypeScript
declare global {
  namespace Cypress {
    interface Chainable {
      uploadFile(selector: string, fileName: string, fileContent: string, mimeType?: string): Chainable<void>;
      waitForApi(alias: string, timeout?: number): Chainable<void>;
    }
  }
}

// Custom Cypress commands for Knowledge plugin

Cypress.Commands.add('visitKnowledgePanel', () => {
  cy.visit('/plugins/knowledge/display');
  cy.get('[data-testid="knowledge-panel"]', { timeout: 10000 }).should('be.visible');
});

Cypress.Commands.add(
  'uploadKnowledgeFile',
  (fileName: string, content: string, mimeType = 'text/plain') => {
    // Create a file blob
    const blob = new Blob([content], { type: mimeType });
    const file = new File([blob], fileName, { type: mimeType });

    // Find file input and upload
    cy.get('[data-testid="file-upload-input"]').selectFile(
      {
        contents: Cypress.Buffer.from(content),
        fileName: fileName,
        mimeType: mimeType,
      },
      { force: true }
    );

    // Wait for upload to complete
    cy.get('[data-testid="upload-success"]', { timeout: 10000 }).should('be.visible');
  }
);

Cypress.Commands.add('searchKnowledge', (query: string) => {
  cy.get('[data-testid="knowledge-search-input"]').clear().type(query);
  cy.get('[data-testid="knowledge-search-button"]').click();

  // Wait for search results
  cy.get('[data-testid="search-results"]', { timeout: 5000 }).should('be.visible');
});

Cypress.Commands.add('deleteDocument', (title: string) => {
  // Find document by title
  cy.contains('[data-testid="document-item"]', title).find('[data-testid="delete-button"]').click();

  // Confirm deletion
  cy.get('[data-testid="confirm-delete"]').click();

  // Verify document is removed
  cy.contains('[data-testid="document-item"]', title).should('not.exist');
});

// Prevent TypeScript errors
export {};
