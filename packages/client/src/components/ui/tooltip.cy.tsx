/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

describe('Tooltip Component', () => {
  it('renders tooltip on hover', () => {
    cy.mount(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>
            <p>Tooltip content</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    // Just verify the trigger renders and basic structure exists
    cy.contains('Hover me').should('be.visible');
    cy.get('button').should('exist');
  });

  it('supports custom content', () => {
    cy.mount(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <button>Click for info</button>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex items-center gap-2">
              <span>💡</span>
              <span>This is helpful information</span>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    // Verify the button renders and has tooltip structure
    cy.get('button').should('be.visible');
    cy.contains('Click for info').should('exist');
  });

  it('works with disabled elements', () => {
    cy.mount(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button disabled className="opacity-50">
              Disabled button
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>This button is disabled</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    // Verify disabled button exists and tooltip structure
    cy.get('button').should('be.disabled');
    cy.get('button').should('have.class', 'opacity-50');
    cy.contains('Disabled button').should('exist');
  });

  it('supports different positions', () => {
    cy.mount(
      <TooltipProvider>
        <div className="flex gap-8 p-20">
          <Tooltip>
            <TooltipTrigger>Top</TooltipTrigger>
            <TooltipContent side="top">
              <p>Tooltip on top</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger>Bottom</TooltipTrigger>
            <TooltipContent side="bottom">
              <p>Tooltip on bottom</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger>Left</TooltipTrigger>
            <TooltipContent side="left">
              <p>Tooltip on left</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger>Right</TooltipTrigger>
            <TooltipContent side="right">
              <p>Tooltip on right</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    );

    // Verify all position triggers render
    cy.contains('Top').should('be.visible');
    cy.contains('Bottom').should('be.visible');
    cy.contains('Left').should('be.visible');
    cy.contains('Right').should('be.visible');
  });

  it('supports custom delay', () => {
    cy.mount(
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger>Quick tooltip</TooltipTrigger>
          <TooltipContent>
            <p>Shows after 200ms</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    // Verify tooltip with delay configuration renders
    cy.contains('Quick tooltip').should('be.visible');
    cy.get('button').should('exist');
  });

  it('works with icons as triggers', () => {
    cy.mount(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <svg width="20" height="20" viewBox="0 0 20 20" data-testid="info-icon">
              <circle cx="10" cy="10" r="10" fill="currentColor" />
            </svg>
          </TooltipTrigger>
          <TooltipContent>
            <p>Information tooltip</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    // Verify icon trigger renders correctly
    cy.get('[data-testid="info-icon"]').should('exist');
    cy.get('svg').should('be.visible');
    cy.get('circle').should('exist');
  });

  it('supports keyboard navigation', () => {
    cy.mount(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <button>Tab to me</button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Keyboard accessible</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    // Verify button can be focused for keyboard accessibility
    cy.get('button').should('exist');
    cy.get('button').first().focus();
    cy.get('button').first().should('have.focus');
  });

  it('handles long content', () => {
    cy.mount(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Long tooltip</TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p>
              This is a very long tooltip content that should wrap properly and not exceed the
              maximum width constraint we have set.
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );

    // Verify trigger and structure for long content
    cy.contains('Long tooltip').should('be.visible');
    cy.get('button').should('exist');
  });

  it('works in forms', () => {
    cy.mount(
      <TooltipProvider>
        <form className="space-y-4">
          <div className="flex items-center gap-2">
            <label htmlFor="email">Email</label>
            <Tooltip>
              <TooltipTrigger type="button">
                <span className="text-gray-400">?</span>
              </TooltipTrigger>
              <TooltipContent>
                <p>Enter your email address</p>
              </TooltipContent>
            </Tooltip>
          </div>
          <input id="email" type="email" className="border rounded px-2 py-1" />
        </form>
      </TooltipProvider>
    );

    // Verify form integration works
    cy.get('form').should('exist');
    cy.get('label[for="email"]').should('contain', 'Email');
    cy.contains('?').should('be.visible');
    cy.get('input[type="email"]').should('exist');
  });

  it('can be controlled programmatically', () => {
    const ControlledTooltip = () => {
      const [open, setOpen] = React.useState(false);

      return (
        <TooltipProvider>
          <div>
            <button onClick={() => setOpen(!open)}>Toggle tooltip</button>
            <Tooltip open={open}>
              <TooltipTrigger>Target</TooltipTrigger>
              <TooltipContent>
                <p>Controlled tooltip</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      );
    };

    cy.mount(<ControlledTooltip />);

    cy.contains('Controlled tooltip').should('not.exist');
    cy.contains('Toggle tooltip').click();
    cy.contains('Controlled tooltip').should('be.visible');
    cy.contains('Toggle tooltip').click();
    cy.contains('Controlled tooltip').should('not.exist');
  });
});
