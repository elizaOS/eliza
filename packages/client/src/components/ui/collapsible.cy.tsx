/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';
import { Button } from './button';

describe('Collapsible Component', () => {
  it('renders basic collapsible', () => {
    cy.mount(
      <Collapsible>
        <CollapsibleTrigger>Toggle Content</CollapsibleTrigger>
        <CollapsibleContent>
          <p>This is collapsible content</p>
        </CollapsibleContent>
      </Collapsible>
    );

    cy.contains('Toggle Content').should('be.visible');
    cy.contains('This is collapsible content').should('not.exist');
  });

  it('toggles content on click', () => {
    cy.mount(
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="outline">Show More</Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="p-4 border rounded">
            <p>Additional content that can be toggled</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );

    // Initially collapsed
    cy.contains('Additional content').should('not.exist');

    // Click to expand
    cy.contains('button', 'Show More').click();
    cy.contains('Additional content').should('be.visible');

    // Click to collapse
    cy.contains('button', 'Show More').click();
    cy.contains('Additional content').should('not.exist');
  });

  it('works as controlled component', () => {
    const TestComponent = () => {
      const [open, setOpen] = React.useState(false);

      return (
        <div>
          <p>Is open: {open ? 'Yes' : 'No'}</p>
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger>Toggle</CollapsibleTrigger>
            <CollapsibleContent>
              <p>Controlled content</p>
            </CollapsibleContent>
          </Collapsible>
          <button onClick={() => setOpen(!open)}>External Toggle</button>
        </div>
      );
    };

    cy.mount(<TestComponent />);

    cy.contains('Is open: No').should('be.visible');
    cy.contains('Controlled content').should('not.exist');

    // Use external toggle
    cy.contains('button', 'External Toggle').click();
    cy.contains('Is open: Yes').should('be.visible');
    cy.contains('Controlled content').should('be.visible');

    // Use internal trigger
    cy.contains('Toggle').click();
    cy.contains('Is open: No').should('be.visible');
    cy.contains('Controlled content').should('not.exist');
  });

  it('supports default open state', () => {
    cy.mount(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Toggle</CollapsibleTrigger>
        <CollapsibleContent>
          <p>Initially visible content</p>
        </CollapsibleContent>
      </Collapsible>
    );

    cy.contains('Initially visible content').should('be.visible');

    // Click to collapse
    cy.contains('Toggle').click();
    cy.contains('Initially visible content').should('not.exist');
  });

  it('can be disabled', () => {
    cy.mount(
      <Collapsible disabled>
        <CollapsibleTrigger asChild>
          <Button disabled>Disabled Toggle</Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p>This content cannot be toggled</p>
        </CollapsibleContent>
      </Collapsible>
    );

    cy.contains('button', 'Disabled Toggle').should('be.disabled');
    cy.contains('This content cannot be toggled').should('not.exist');

    // Try to click
    cy.contains('button', 'Disabled Toggle').click({ force: true });
    cy.contains('This content cannot be toggled').should('not.exist');
  });

  it('supports custom className', () => {
    cy.mount(
      <Collapsible className="custom-collapsible border p-4">
        <CollapsibleTrigger className="custom-trigger text-blue-600">
          Click to expand
        </CollapsibleTrigger>
        <CollapsibleContent className="custom-content mt-4">
          <p>Styled content</p>
        </CollapsibleContent>
      </Collapsible>
    );

    cy.get('.custom-collapsible').should('have.class', 'border');
    cy.get('.custom-trigger').should('have.class', 'text-blue-600');

    cy.contains('Click to expand').click();
    cy.get('.custom-content').should('have.class', 'mt-4');
  });

  it('handles multiple collapsibles', () => {
    cy.mount(
      <div className="space-y-4">
        <Collapsible>
          <CollapsibleTrigger>First Section</CollapsibleTrigger>
          <CollapsibleContent>
            <p>First content</p>
          </CollapsibleContent>
        </Collapsible>

        <Collapsible>
          <CollapsibleTrigger>Second Section</CollapsibleTrigger>
          <CollapsibleContent>
            <p>Second content</p>
          </CollapsibleContent>
        </Collapsible>
      </div>
    );

    // Both initially collapsed
    cy.contains('First content').should('not.exist');
    cy.contains('Second content').should('not.exist');

    // Expand first
    cy.contains('First Section').click();
    cy.contains('First content').should('be.visible');
    cy.contains('Second content').should('not.exist');

    // Expand second
    cy.contains('Second Section').click();
    cy.contains('First content').should('be.visible');
    cy.contains('Second content').should('be.visible');
  });

  it('works with complex content', () => {
    cy.mount(
      <Collapsible>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Advanced Settings</h3>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              <span>Show</span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="mt-4 space-y-4">
            <div>
              <label>Option 1</label>
              <input type="checkbox" />
            </div>
            <div>
              <label>Option 2</label>
              <input type="checkbox" />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );

    cy.contains('Advanced Settings').should('be.visible');
    cy.get('input[type="checkbox"]').should('not.exist');

    cy.contains('button', 'Show').click();
    cy.get('input[type="checkbox"]').should('have.length', 2);
  });

  it('animates smoothly', () => {
    cy.mount(
      <Collapsible>
        <CollapsibleTrigger>Animate</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="p-4 bg-gray-100">
            <p>This content animates in and out</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );

    cy.contains('Animate').click();
    cy.contains('This content animates').should('be.visible');
  });

  it('handles nested collapsibles', () => {
    cy.mount(
      <Collapsible>
        <CollapsibleTrigger>Outer Collapsible</CollapsibleTrigger>
        <CollapsibleContent>
          <div className="p-4 border">
            <p>Outer content</p>
            <Collapsible>
              <CollapsibleTrigger>Inner Collapsible</CollapsibleTrigger>
              <CollapsibleContent>
                <p className="p-4 bg-gray-100">Inner content</p>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );

    // Both initially collapsed
    cy.contains('Outer content').should('not.exist');
    cy.contains('Inner content').should('not.exist');

    // Expand outer
    cy.contains('Outer Collapsible').click();
    cy.contains('Outer content').should('be.visible');
    cy.contains('Inner content').should('not.exist');

    // Expand inner
    cy.contains('Inner Collapsible').click();
    cy.contains('Inner content').should('be.visible');
  });

  it('maintains state during content updates', () => {
    const TestComponent = () => {
      const [count, setCount] = React.useState(0);

      return (
        <div>
          <button onClick={() => setCount(count + 1)}>Update Count: {count}</button>
          <Collapsible>
            <CollapsibleTrigger>Toggle</CollapsibleTrigger>
            <CollapsibleContent>
              <p>Content with count: {count}</p>
            </CollapsibleContent>
          </Collapsible>
        </div>
      );
    };

    cy.mount(<TestComponent />);

    // Expand collapsible
    cy.contains('Toggle').click();
    cy.contains('Content with count: 0').should('be.visible');

    // Update count
    cy.contains('button', 'Update Count: 0').click();

    // Content should still be visible with new count
    cy.contains('Content with count: 1').should('be.visible');
  });
});
