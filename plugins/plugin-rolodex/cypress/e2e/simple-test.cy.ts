describe('Simple Test', () => {
  it('should visit the Cypress example page', () => {
    cy.visit('https://example.cypress.io', { failOnStatusCode: false });
    cy.contains('type').click();
    cy.url().should('include', '/commands/actions');
  });
}); 