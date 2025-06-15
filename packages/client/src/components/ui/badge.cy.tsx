/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Badge, badgeVariants } from './badge';

describe('Badge Component', () => {
  it('renders correctly with default props', () => {
    cy.mount(<Badge>Default Badge</Badge>);

    cy.get('[data-testid="badge"]').should('exist');
    cy.get('[data-testid="badge"]').should('contain', 'Default Badge');
    cy.get('[data-testid="badge"]').should('have.class', 'inline-flex');
  });

  describe('Variants', () => {
    it('renders default variant correctly', () => {
      cy.mount(<Badge variant="default">Default</Badge>);

      cy.get('[data-testid="badge"]')
        .should('have.class', 'bg-primary')
        .should('have.class', 'text-primary-foreground');
    });

    it('renders secondary variant correctly', () => {
      cy.mount(<Badge variant="secondary">Secondary</Badge>);

      cy.get('[data-testid="badge"]')
        .should('have.class', 'bg-secondary')
        .should('have.class', 'text-secondary-foreground');
    });

    it('renders destructive variant correctly', () => {
      cy.mount(<Badge variant="destructive">Destructive</Badge>);

      cy.get('[data-testid="badge"]')
        .should('have.class', 'bg-destructive')
        .should('have.class', 'text-destructive-foreground');
    });

    it('renders outline variant correctly', () => {
      cy.mount(<Badge variant="outline">Outline</Badge>);

      cy.get('[data-testid="badge"]').should('have.class', 'border');
    });
  });

  it('applies custom className', () => {
    cy.mount(<Badge className="custom-badge ml-2">Custom</Badge>);

    cy.get('[data-testid="badge"]')
      .should('have.class', 'custom-badge')
      .should('have.class', 'ml-2');
  });

  it('renders with different content types', () => {
    cy.mount(
      <div>
        <Badge>Text only</Badge>
        <Badge>
          <span>With span</span>
        </Badge>
        <Badge>
          <span className="mr-1">🔥</span>
          With emoji
        </Badge>
      </div>
    );

    cy.get('[data-testid="badge"]').should('have.length', 3);
    cy.get('[data-testid="badge"]').first().should('contain', 'Text only');
    cy.get('[data-testid="badge"]').eq(1).find('span').should('exist');
    cy.get('[data-testid="badge"]').last().should('contain', '🔥');
  });

  it('renders inline with text', () => {
    cy.mount(
      <p>
        This is some text with a <Badge>badge</Badge> inline.
      </p>
    );

    cy.get('[data-testid="badge"]').should('be.visible');
    cy.get('p').should('contain', 'This is some text with a');
    cy.get('p').should('contain', 'inline.');
  });

  it('can be used as a clickable element', () => {
    const onClick = cy.stub();

    cy.mount(
      <Badge className="cursor-pointer" onClick={onClick}>
        Clickable
      </Badge>
    );

    cy.get('[data-testid="badge"]').click();
    cy.wrap(onClick).should('have.been.calledOnce');
  });

  it('renders multiple badges in a group', () => {
    cy.mount(
      <div className="flex gap-2">
        <Badge>Badge 1</Badge>
        <Badge variant="secondary">Badge 2</Badge>
        <Badge variant="outline">Badge 3</Badge>
      </div>
    );

    cy.get('[data-testid="badge"]').should('have.length', 3);
    cy.get('.flex.gap-2').should('exist');
  });

  it('supports data attributes', () => {
    cy.mount(
      <Badge data-testid="custom-badge" data-status="active">
        Active
      </Badge>
    );

    cy.get('[data-testid="custom-badge"]')
      .should('exist')
      .should('have.attr', 'data-status', 'active');
  });

  it('has correct accessibility attributes', () => {
    cy.mount(
      <Badge role="status" aria-label="User status">
        Online
      </Badge>
    );

    cy.get('[data-testid="badge"]')
      .should('have.attr', 'role', 'status')
      .should('have.attr', 'aria-label', 'User status');
  });

  it('badgeVariants function works correctly', () => {
    // Test the badgeVariants function directly
    const defaultClasses = badgeVariants({ variant: 'default' });
    const secondaryClasses = badgeVariants({ variant: 'secondary' });

    expect(defaultClasses).to.include('bg-primary');
    expect(secondaryClasses).to.include('bg-secondary');
  });
});
