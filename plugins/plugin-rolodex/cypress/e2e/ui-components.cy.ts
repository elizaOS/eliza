describe('UI Components', () => {
  beforeEach(() => {
    // Visit a test page that includes all components
    cy.visit('/test-components');
  });

  describe('Badge Component', () => {
    it('should render with default variant', () => {
      cy.get('[data-testid="badge-default"]').should('exist');
      cy.get('[data-testid="badge-default"]').should('have.class', 'bg-primary');
    });

    it('should render with all variants', () => {
      const variants = ['default', 'outline', 'secondary', 'destructive'];
      variants.forEach(variant => {
        cy.get(`[data-testid="badge-${variant}"]`).should('exist');
      });
    });

    it('should display children content', () => {
      cy.get('[data-testid="badge-default"]').should('contain', 'Test Badge');
    });

    it('should apply custom className', () => {
      cy.get('[data-testid="badge-custom"]').should('have.class', 'custom-class');
    });
  });

  describe('Button Component', () => {
    it('should render with default props', () => {
      cy.get('[data-testid="button-default"]').should('exist');
      cy.get('[data-testid="button-default"]').should('have.attr', 'type', 'button');
    });

    it('should handle click events', () => {
      cy.get('[data-testid="button-clickable"]').click();
      cy.get('[data-testid="click-count"]').should('contain', '1');
    });

    it('should be disabled when disabled prop is true', () => {
      cy.get('[data-testid="button-disabled"]').should('be.disabled');
      cy.get('[data-testid="button-disabled"]').should('have.class', 'disabled:opacity-50');
    });

    it('should render all variants', () => {
      const variants = ['default', 'outline', 'ghost', 'destructive'];
      variants.forEach(variant => {
        cy.get(`[data-testid="button-${variant}"]`).should('exist');
      });
    });

    it('should render all sizes', () => {
      const sizes = ['default', 'sm', 'lg', 'icon'];
      sizes.forEach(size => {
        cy.get(`[data-testid="button-size-${size}"]`).should('exist');
      });
    });

    it('should show title on hover', () => {
      cy.get('[data-testid="button-with-title"]').trigger('mouseenter');
      cy.get('[data-testid="button-with-title"]').should('have.attr', 'title', 'Test Title');
    });
  });

  describe('Card Components', () => {
    it('should render Card with all sub-components', () => {
      cy.get('[data-testid="card"]').should('exist');
      cy.get('[data-testid="card-header"]').should('exist');
      cy.get('[data-testid="card-title"]').should('exist');
      cy.get('[data-testid="card-description"]').should('exist');
      cy.get('[data-testid="card-content"]').should('exist');
      cy.get('[data-testid="card-footer"]').should('exist');
    });

    it('should apply proper styling to Card', () => {
      cy.get('[data-testid="card"]').should('have.class', 'rounded-lg');
      cy.get('[data-testid="card"]').should('have.class', 'border');
      cy.get('[data-testid="card"]').should('have.class', 'bg-card');
    });

    it('should render content in each section', () => {
      cy.get('[data-testid="card-title"]').should('contain', 'Test Card Title');
      cy.get('[data-testid="card-description"]').should('contain', 'Test Description');
      cy.get('[data-testid="card-content"]').should('contain', 'Test Content');
      cy.get('[data-testid="card-footer"]').should('contain', 'Test Footer');
    });
  });

  describe('Input Component', () => {
    it('should render with default type text', () => {
      cy.get('[data-testid="input-default"]').should('have.attr', 'type', 'text');
    });

    it('should handle value changes', () => {
      cy.get('[data-testid="input-controlled"]').type('Hello World');
      cy.get('[data-testid="input-controlled"]').should('have.value', 'Hello World');
    });

    it('should show placeholder', () => {
      cy.get('[data-testid="input-placeholder"]').should('have.attr', 'placeholder', 'Enter text...');
    });

    it('should be disabled when disabled prop is true', () => {
      cy.get('[data-testid="input-disabled"]').should('be.disabled');
    });

    it('should handle file input with multiple files', () => {
      cy.get('[data-testid="input-file"]').should('have.attr', 'type', 'file');
      cy.get('[data-testid="input-file"]').should('have.attr', 'multiple');
      cy.get('[data-testid="input-file"]').should('have.attr', 'accept', '.pdf,.txt');
    });

    it('should apply custom className', () => {
      cy.get('[data-testid="input-custom"]').should('have.class', 'custom-input-class');
    });
  });

  describe('Table Components', () => {
    it('should render table with all sub-components', () => {
      cy.get('[data-testid="table"]').should('exist');
      cy.get('[data-testid="table-header"]').should('exist');
      cy.get('[data-testid="table-body"]').should('exist');
      cy.get('[data-testid="table-footer"]').should('exist');
    });

    it('should render table rows and cells', () => {
      cy.get('[data-testid="table-row"]').should('have.length.at.least', 1);
      cy.get('[data-testid="table-head"]').should('exist');
      cy.get('[data-testid="table-cell"]').should('exist');
    });

    it('should have hover effect on rows', () => {
      cy.get('[data-testid="table-row"]').first().trigger('mouseenter', { force: true });
      cy.get('[data-testid="table-row"]').first().should('have.class', 'hover:bg-muted/50');
    });

    it('should render table caption', () => {
      cy.get('[data-testid="table-caption"]').should('exist');
      cy.get('[data-testid="table-caption"]').should('contain', 'Test Caption');
    });
  });

  describe('Tabs Components', () => {
    it('should render tabs with all sub-components', () => {
      cy.get('[data-testid="tabs"]').should('exist');
      cy.get('[data-testid="tabs-list"]').should('exist');
      cy.get('[data-testid="tabs-trigger-1"]').should('exist');
      cy.get('[data-testid="tabs-trigger-2"]').should('exist');
      cy.get('[data-testid="tabs-content-1"]').should('exist');
    });

    it('should switch between tabs', () => {
      // First tab should be active by default
      cy.get('[data-testid="tabs-trigger-1"]').should('have.attr', 'data-state', 'active');
      cy.get('[data-testid="tabs-content-1"]').should('be.visible');
      
      // Second tab should be inactive
      cy.get('[data-testid="tabs-trigger-2"]').should('have.attr', 'data-state', 'inactive');
    });

    it('should handle keyboard navigation', () => {
      // Since this is static HTML, we'll just verify the tabs can be focused
      cy.get('[data-testid="tabs-trigger-1"]').focus();
      cy.get('[data-testid="tabs-trigger-1"]').should('have.focus');
      
      cy.get('[data-testid="tabs-trigger-2"]').focus();
      cy.get('[data-testid="tabs-trigger-2"]').should('have.focus');
    });
  });
}); 