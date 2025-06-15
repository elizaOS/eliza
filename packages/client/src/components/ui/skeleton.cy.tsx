/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Skeleton } from './skeleton';

describe('Skeleton Component', () => {
  it('renders correctly with default props', () => {
    cy.mount(<Skeleton />);

    cy.get('[data-testid="skeleton"]').should('exist');
    cy.get('[data-testid="skeleton"]').should('have.class', 'animate-pulse');
    cy.get('[data-testid="skeleton"]').should('have.class', 'rounded-md');
    cy.get('[data-testid="skeleton"]').should('have.class', 'bg-primary/10');
  });

  it('applies custom className', () => {
    cy.mount(<Skeleton className="w-full h-20" />);

    cy.get('[data-testid="skeleton"]').should('have.class', 'w-full').should('have.class', 'h-20');
  });

  it('renders multiple skeletons for loading lists', () => {
    cy.mount(
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );

    cy.get('[data-testid="skeleton"]').should('have.length', 3);
    cy.get('[data-testid="skeleton"]').first().should('have.class', 'w-full');
    cy.get('[data-testid="skeleton"]').eq(1).should('have.class', 'w-3/4');
    cy.get('[data-testid="skeleton"]').last().should('have.class', 'w-1/2');
  });

  it('renders card skeleton layout', () => {
    cy.mount(
      <div className="rounded-lg border p-4">
        <div className="flex items-center space-x-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-[250px]" />
            <Skeleton className="h-4 w-[200px]" />
          </div>
        </div>
      </div>
    );

    cy.get('[data-testid="skeleton"]').should('have.length', 3);
    cy.get('.rounded-full').should('exist');
  });

  it('supports different shapes', () => {
    cy.mount(
      <div className="space-y-4">
        <Skeleton className="h-12 w-12 rounded-full" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-4 w-32" />
      </div>
    );

    cy.get('[data-testid="skeleton"]').first().should('have.class', 'rounded-full');
    cy.get('[data-testid="skeleton"]').eq(1).should('have.class', 'rounded-lg');
  });

  it('works for text loading', () => {
    cy.mount(
      <div className="space-y-2">
        <h2 className="text-2xl font-bold">
          <Skeleton className="h-8 w-48" />
        </h2>
        <p>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </p>
      </div>
    );

    cy.get('h2').find('[data-testid="skeleton"]').should('exist');
    cy.get('p').find('[data-testid="skeleton"]').should('have.length', 3);
  });

  it('maintains proper sizing', () => {
    cy.mount(<Skeleton className="h-32 w-64" />);

    cy.get('[data-testid="skeleton"]').should('have.class', 'h-32').should('have.class', 'w-64');
  });

  it('works for image placeholders', () => {
    cy.mount(
      <div className="grid grid-cols-3 gap-4">
        <Skeleton className="aspect-square w-full rounded-lg" />
        <Skeleton className="aspect-square w-full rounded-lg" />
        <Skeleton className="aspect-square w-full rounded-lg" />
      </div>
    );

    cy.get('[data-testid="skeleton"]').should('have.length', 3);
    cy.get('[data-testid="skeleton"]').each(($el) => {
      cy.wrap($el).should('have.class', 'aspect-square');
    });
  });

  it('works for form field loading', () => {
    cy.mount(
      <div className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" /> {/* Label */}
          <Skeleton className="h-10 w-full rounded-md" /> {/* Input */}
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" /> {/* Label */}
          <Skeleton className="h-24 w-full rounded-md" /> {/* Textarea */}
        </div>
      </div>
    );

    cy.get('[data-testid="skeleton"]').should('have.length', 4);
  });

  it('supports data attributes', () => {
    cy.mount(
      <Skeleton data-testid="custom-skeleton" data-loading="true" className="h-20 w-full" />
    );

    cy.get('[data-testid="custom-skeleton"]')
      .should('exist')
      .should('have.attr', 'data-loading', 'true');
  });

  it('animation is present', () => {
    cy.mount(<Skeleton />);

    cy.get('[data-testid="skeleton"]').should('have.class', 'animate-pulse');
  });

  it('works in dark mode', () => {
    cy.mount(
      <div className="dark bg-gray-900 p-4">
        <Skeleton className="h-20 w-full" />
      </div>
    );

    cy.get('[data-testid="skeleton"]').should('be.visible');
  });
});
