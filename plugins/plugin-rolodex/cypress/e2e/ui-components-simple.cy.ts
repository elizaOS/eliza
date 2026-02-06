describe('UI Components - Simple Tests', () => {
  beforeEach(() => {
    cy.visit('/test-components');
  });

  describe('Badge Component', () => {
    it('should render badges with all variants', () => {
      cy.get('[data-testid="badge-default"]').should('exist').and('be.visible');
      cy.get('[data-testid="badge-outline"]').should('exist').and('be.visible');
      cy.get('[data-testid="badge-secondary"]').should('exist').and('be.visible');
      cy.get('[data-testid="badge-destructive"]').should('exist').and('be.visible');
    });

    it('should display correct text content', () => {
      cy.get('[data-testid="badge-default"]').should('contain', 'Test Badge');
    });
  });

  describe('Button Component', () => {
    it('should render buttons with all variants', () => {
      cy.get('[data-testid="button-default"]').should('exist').and('be.visible');
      cy.get('[data-testid="button-outline"]').should('exist').and('be.visible');
      cy.get('[data-testid="button-ghost"]').should('exist').and('be.visible');
      cy.get('[data-testid="button-destructive"]').should('exist').and('be.visible');
    });

    it('should handle click events', () => {
      cy.get('[data-testid="button-clickable"]').click();
      cy.get('[data-testid="click-count"]').should('contain', '1');
      
      cy.get('[data-testid="button-clickable"]').click();
      cy.get('[data-testid="click-count"]').should('contain', '2');
    });

    it('should be disabled when disabled prop is true', () => {
      cy.get('[data-testid="button-disabled"]').should('be.disabled');
    });
  });

  describe('Card Component', () => {
    it('should render card with all sections', () => {
      cy.get('[data-testid="card"]').should('exist').and('be.visible');
      cy.get('[data-testid="card-header"]').should('exist');
      cy.get('[data-testid="card-title"]').should('contain', 'Test Card Title');
      cy.get('[data-testid="card-description"]').should('contain', 'Test Description');
      cy.get('[data-testid="card-content"]').should('contain', 'Test Content');
      cy.get('[data-testid="card-footer"]').should('contain', 'Test Footer');
    });
  });

  describe('Input Component', () => {
    it('should render different input types', () => {
      cy.get('[data-testid="input-default"]').should('have.attr', 'type', 'text');
      cy.get('[data-testid="input-file"]').should('have.attr', 'type', 'file');
    });

    it('should handle text input', () => {
      cy.get('[data-testid="input-controlled"]')
        .clear()
        .type('Hello Cypress')
        .should('have.value', 'Hello Cypress');
    });

    it('should show placeholder text', () => {
      cy.get('[data-testid="input-placeholder"]')
        .should('have.attr', 'placeholder', 'Enter text...');
    });
  });

  describe('Table Component', () => {
    it('should render table structure', () => {
      cy.get('[data-testid="table"]').should('exist');
      cy.get('[data-testid="table-header"]').should('exist');
      cy.get('[data-testid="table-body"]').should('exist');
      cy.get('[data-testid="table-footer"]').should('exist');
      cy.get('[data-testid="table-caption"]').should('contain', 'Test Caption');
    });
  });
}); 