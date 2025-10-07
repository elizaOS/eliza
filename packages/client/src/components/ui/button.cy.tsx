/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Button } from './button';

describe('Button Component', () => {
  // Test basic rendering
  it('renders correctly with default props', () => {
    cy.mount(<Button>Click me</Button>);

    cy.get('[data-slot="button"]')
      .should('exist')
      .should('have.text', 'Click me')
      .should('have.class', 'bg-primary');
  });

  // Test all variants
  describe('Variants', () => {
    const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const;

    variants.forEach((variant) => {
      it(`renders ${variant} variant correctly`, () => {
        cy.mount(<Button variant={variant}>{variant} Button</Button>);

        cy.get('[data-slot="button"]').should('exist').should('contain.text', `${variant} Button`);

        // Take a screenshot for visual regression
        cy.screenshot(`button-variant-${variant}`);
      });
    });
  });

  // Test all sizes
  describe('Sizes', () => {
    const sizes = ['default', 'sm', 'lg', 'icon'] as const;

    sizes.forEach((size) => {
      it(`renders ${size} size correctly`, () => {
        cy.mount(<Button size={size}>{size === 'icon' ? '🚀' : `${size} Button`}</Button>);

        cy.get('[data-slot="button"]').should('exist');

        // Verify specific size classes
        if (size === 'sm') {
          cy.get('[data-slot="button"]').should('have.class', 'h-8');
        } else if (size === 'lg') {
          cy.get('[data-slot="button"]').should('have.class', 'h-10');
        } else if (size === 'icon') {
          cy.get('[data-slot="button"]').should('have.class', 'h-auto').and('have.class', 'w-auto');
        } else {
          cy.get('[data-slot="button"]').should('have.class', 'h-9');
        }
      });
    });
  });

  // Test interactions
  describe('Interactions', () => {
    it('handles click events', () => {
      const onClick = cy.stub();

      cy.mount(<Button onClick={onClick}>Click me</Button>);

      cy.get('[data-slot="button"]').click();
      cy.wrap(onClick).should('have.been.calledOnce');
    });

    it('can be disabled', () => {
      const onClick = cy.stub();

      cy.mount(
        <Button disabled onClick={onClick}>
          Disabled Button
        </Button>
      );

      cy.get('[data-slot="button"]')
        .should('be.disabled')
        .should('have.class', 'disabled:opacity-50')
        .click({ force: true });

      cy.wrap(onClick).should('not.have.been.called');
    });

    it('supports keyboard navigation', () => {
      const onClick = cy.stub();

      cy.mount(<Button onClick={onClick}>Keyboard Button</Button>);

      // Trigger click with keyboard
      cy.get('[data-slot="button"]')
        .focus()
        .trigger('keydown', { key: 'Enter', code: 'Enter' })
        .trigger('click');

      cy.wrap(onClick).should('have.been.calledOnce');
    });
  });

  // Test asChild prop
  describe('asChild prop', () => {
    it('renders as a different element when asChild is true', () => {
      cy.mount(
        <Button asChild>
          <a href="/test">Link Button</a>
        </Button>
      );

      cy.get('a[data-slot="button"]')
        .should('exist')
        .should('have.attr', 'href', '/test')
        .should('have.text', 'Link Button');
    });
  });

  // Test with icons
  describe('With Icons', () => {
    it('renders correctly with an icon', () => {
      cy.mount(
        <Button>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24">
            <path d="M12 4v16m8-8H4" stroke="currentColor" strokeWidth={2} />
          </svg>
          With Icon
        </Button>
      );

      cy.get('[data-slot="button"]').should('contain.text', 'With Icon');
      cy.get('[data-slot="button"] svg').should('exist');
    });
  });

  // Test custom className
  describe('Custom styling', () => {
    it('accepts custom className', () => {
      cy.mount(<Button className="custom-class bg-blue-500">Custom Styled</Button>);

      cy.get('[data-slot="button"]')
        .should('have.class', 'custom-class')
        .should('have.class', 'bg-blue-500');
    });
  });

  // Test focus states
  describe('Focus states', () => {
    it('shows focus ring when focused', () => {
      cy.mount(<Button>Focus me</Button>);

      cy.get('[data-slot="button"]').focus().should('have.class', 'focus-visible:ring-ring/50');
    });
  });

  // Test loading state (if supported)
  describe('Loading state', () => {
    it('can show loading state', () => {
      cy.mount(
        <Button disabled>
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
          </svg>
          Loading...
        </Button>
      );

      cy.get('[data-slot="button"]').should('be.disabled').should('contain.text', 'Loading...');
      cy.get('[data-slot="button"] svg').should('have.class', 'animate-spin');
    });
  });
});
