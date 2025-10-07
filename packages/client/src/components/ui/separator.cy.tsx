/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Separator } from './separator';

describe('Separator Component', () => {
  it('renders correctly with default props', () => {
    cy.mount(<Separator />);

    cy.get('[data-testid="separator"]').should('exist');
    cy.get('[data-testid="separator"]').should('have.attr', 'role', 'none'); // decorative is true by default
    cy.get('[data-testid="separator"]').should('have.class', 'shrink-0');
  });

  describe('Orientation', () => {
    it('renders horizontal separator correctly', () => {
      cy.mount(<Separator orientation="horizontal" />);

      cy.get('[data-testid="separator"]')
        .should('have.attr', 'data-orientation', 'horizontal')
        .should('have.class', 'h-[1px]')
        .should('have.class', 'w-full');
    });

    it('renders vertical separator correctly', () => {
      cy.mount(
        <div className="flex h-20">
          <div>Left</div>
          <Separator orientation="vertical" />
          <div>Right</div>
        </div>
      );

      cy.get('[data-testid="separator"]')
        .should('have.attr', 'data-orientation', 'vertical')
        .should('have.class', 'h-full')
        .should('have.class', 'w-[1px]');
    });
  });

  it('applies custom className', () => {
    cy.mount(<Separator className="my-custom-separator bg-red-500" />);

    cy.get('[data-testid="separator"]')
      .should('have.class', 'my-custom-separator')
      .should('have.class', 'bg-red-500');
  });

  it('decorative prop sets correct aria attributes', () => {
    cy.mount(<Separator decorative />);

    cy.get('[data-testid="separator"]').should('have.attr', 'role', 'none');
  });

  it('renders in a card layout', () => {
    cy.mount(
      <div className="max-w-sm rounded-lg border p-4">
        <h3 className="font-semibold">Card Title</h3>
        <Separator className="my-2" />
        <p className="text-sm text-gray-600">Card content goes here.</p>
      </div>
    );

    cy.get('[data-testid="separator"]').should('be.visible');
    cy.get('.my-2').should('exist');
  });

  it('renders multiple separators in a list', () => {
    cy.mount(
      <ul className="space-y-2">
        <li>Item 1</li>
        <Separator />
        <li>Item 2</li>
        <Separator />
        <li>Item 3</li>
      </ul>
    );

    cy.get('[data-testid="separator"]').should('have.length', 2);
  });

  it('works with different spacing', () => {
    cy.mount(
      <div>
        <div>Content 1</div>
        <Separator className="my-1" />
        <div>Content 2</div>
        <Separator className="my-4" />
        <div>Content 3</div>
        <Separator className="my-8" />
        <div>Content 4</div>
      </div>
    );

    cy.get('[data-testid="separator"]').should('have.length', 3);
    cy.get('.my-1').should('exist');
    cy.get('.my-4').should('exist');
    cy.get('.my-8').should('exist');
  });

  it('renders in a form layout', () => {
    cy.mount(
      <form className="space-y-4">
        <div>
          <label>Name</label>
          <input type="text" className="w-full border rounded px-2 py-1" />
        </div>
        <Separator />
        <div>
          <label>Email</label>
          <input type="email" className="w-full border rounded px-2 py-1" />
        </div>
      </form>
    );

    cy.get('[data-testid="separator"]').should('exist');
    cy.get('form').find('[data-testid="separator"]').should('have.length', 1);
  });

  it('supports custom styles', () => {
    cy.mount(
      <Separator
        className="bg-gradient-to-r from-transparent via-gray-500 to-transparent"
        style={{ height: '2px' }}
      />
    );

    cy.get('[data-testid="separator"]')
      .should('have.class', 'bg-gradient-to-r')
      .should('have.css', 'height', '2px');
  });

  it('works in dark mode', () => {
    cy.mount(
      <div className="dark bg-gray-900 p-4">
        <div className="text-white">Dark mode content</div>
        <Separator className="my-4 bg-gray-700" />
        <div className="text-white">More content</div>
      </div>
    );

    cy.get('[data-testid="separator"]').should('have.class', 'bg-gray-700');
  });
});
