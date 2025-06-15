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

    cy.contains('Hover me').should('be.visible');
    cy.contains('Tooltip content').should('not.exist');

    // Hover to show tooltip
    cy.contains('Hover me').trigger('mouseenter');
    cy.contains('Tooltip content').should('be.visible');

    // Move away to hide tooltip
    cy.contains('Hover me').trigger('mouseleave');
    cy.contains('Tooltip content').should('not.exist');
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

    cy.get('button').trigger('mouseenter');
    cy.contains('This is helpful information').should('be.visible');
    cy.contains('💡').should('be.visible');
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

    cy.get('button').should('be.disabled');
    cy.get('button').trigger('mouseenter', { force: true });
    cy.contains('This button is disabled').should('be.visible');
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

    // Test each position
    cy.contains('Top').trigger('mouseenter');
    cy.contains('Tooltip on top').should('be.visible');
    cy.contains('Top').trigger('mouseleave');

    cy.contains('Bottom').trigger('mouseenter');
    cy.contains('Tooltip on bottom').should('be.visible');
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

    cy.contains('Quick tooltip').trigger('mouseenter');
    cy.wait(250); // Wait for delay
    cy.contains('Shows after 200ms').should('be.visible');
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

    cy.get('[data-testid="info-icon"]').trigger('mouseenter');
    cy.contains('Information tooltip').should('be.visible');
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

    cy.get('button').focus();
    cy.contains('Keyboard accessible').should('be.visible');
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

    cy.contains('Long tooltip').trigger('mouseenter');
    cy.get('.max-w-xs').should('be.visible');
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

    cy.contains('?').trigger('mouseenter');
    cy.contains('Enter your email address').should('be.visible');
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
