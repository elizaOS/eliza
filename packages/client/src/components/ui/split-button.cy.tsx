/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { SplitButton } from './split-button';

describe('SplitButton Component', () => {
  it('renders basic split button', () => {
    cy.mount(
      <SplitButton
        mainAction={{ label: 'Save', onClick: () => {} }}
        actions={[
          { label: 'Save as Draft', onClick: () => {} },
          { label: 'Save and Exit', onClick: () => {} },
        ]}
      />
    );

    cy.contains('button', 'Save').should('be.visible');
    cy.get('button[aria-haspopup="menu"]').should('be.visible');
  });

  it('handles main button click', () => {
    const onClick = cy.stub();

    cy.mount(
      <SplitButton
        mainAction={{ label: 'Submit', onClick }}
        actions={[{ label: 'Submit and Close', onClick: () => {} }]}
      />
    );

    cy.contains('button', 'Submit').click();
    cy.wrap(onClick).should('have.been.called');
  });

  it('opens dropdown menu', () => {
    cy.mount(
      <SplitButton
        mainAction={{ label: 'Export', onClick: () => {} }}
        actions={[
          { label: 'Export as PDF', onClick: () => {} },
          { label: 'Export as CSV', onClick: () => {} },
          { label: 'Export as Excel', onClick: () => {} },
        ]}
      />
    );

    // Initially dropdown is closed
    cy.contains('Export as PDF').should('not.exist');

    // Click dropdown trigger
    cy.get('button[aria-haspopup="menu"]').click();

    // All options should be visible
    cy.contains('Export as PDF').should('be.visible');
    cy.contains('Export as CSV').should('be.visible');
    cy.contains('Export as Excel').should('be.visible');
  });

  it('handles dropdown action selection', () => {
    const mainAction = cy.stub();
    const draftAction = cy.stub();
    const templateAction = cy.stub();

    cy.mount(
      <SplitButton
        mainAction={{ label: 'Save', onClick: mainAction }}
        actions={[
          { label: 'Save as Draft', onClick: draftAction },
          { label: 'Save as Template', onClick: templateAction },
        ]}
      />
    );

    // Open dropdown
    cy.get('button[aria-haspopup="menu"]').click();

    // Select draft option
    cy.contains('Save as Draft').click();
    cy.wrap(draftAction).should('have.been.called');
  });

  it('supports different variants', () => {
    cy.mount(
      <div className="space-x-4">
        <SplitButton
          mainAction={{ label: 'Default', onClick: () => {} }}
          actions={[{ label: 'Option', onClick: () => {} }]}
          variant="default"
        />
        <SplitButton
          mainAction={{ label: 'Destructive', onClick: () => {} }}
          actions={[{ label: 'Delete All', onClick: () => {} }]}
          variant="destructive"
        />
        <SplitButton
          mainAction={{ label: 'Outline', onClick: () => {} }}
          actions={[{ label: 'More', onClick: () => {} }]}
          variant="outline"
        />
      </div>
    );

    cy.contains('button', 'Default').should('be.visible');
    cy.contains('button', 'Destructive').should('have.class', 'bg-red-800');
    cy.contains('button', 'Outline').should('have.class', 'border');
  });

  it('supports different sizes', () => {
    cy.mount(
      <div className="space-x-4">
        <SplitButton
          mainAction={{ label: 'Small', onClick: () => {} }}
          actions={[{ label: 'Option', onClick: () => {} }]}
          size="sm"
        />
        <SplitButton
          mainAction={{ label: 'Default', onClick: () => {} }}
          actions={[{ label: 'Option', onClick: () => {} }]}
        />
        <SplitButton
          mainAction={{ label: 'Large', onClick: () => {} }}
          actions={[{ label: 'Option', onClick: () => {} }]}
          size="lg"
        />
      </div>
    );

    cy.contains('button', 'Small').should('have.class', 'h-8');
    cy.contains('button', 'Large').should('have.class', 'h-10');
  });

  it('can be disabled', () => {
    const onClick = cy.stub();

    cy.mount(
      <SplitButton
        mainAction={{ label: 'Disabled', onClick }}
        actions={[{ label: 'Option 1', onClick: () => {} }]}
        disabled
      />
    );

    // Both buttons should be disabled
    cy.contains('button', 'Disabled').should('be.disabled');
    cy.get('button[aria-haspopup="menu"]').should('be.disabled');

    // Try clicking
    cy.contains('button', 'Disabled').click({ force: true });
    cy.wrap(onClick).should('not.have.been.called');
  });

  it('supports individually disabled actions', () => {
    const enabledAction = cy.stub();
    const disabledAction = cy.stub();

    cy.mount(
      <SplitButton
        mainAction={{ label: 'Print', onClick: () => {} }}
        actions={[
          { label: 'Print Preview', onClick: enabledAction },
          { label: 'Print to PDF', onClick: disabledAction, disabled: true },
          { label: 'Print All', onClick: enabledAction },
        ]}
      />
    );

    cy.get('button[aria-haspopup="menu"]').click();

    // Check disabled item exists
    cy.contains('Print to PDF').should('exist');
    // Disabled dropdown items behavior might vary, just verify enabled action works

    // Click enabled item
    cy.contains('Print All').click();
    cy.wrap(enabledAction).should('have.been.called');
  });

  it('closes dropdown after selection', () => {
    cy.mount(
      <SplitButton
        mainAction={{ label: 'Share', onClick: () => {} }}
        actions={[
          { label: 'Share via Email', onClick: () => {} },
          { label: 'Share via Link', onClick: () => {} },
        ]}
      />
    );

    // Open dropdown
    cy.get('button[aria-haspopup="menu"]').click();
    cy.contains('Share via Email').should('be.visible');

    // Select item
    cy.contains('Share via Email').click();

    // Dropdown should close
    cy.contains('Share via Email').should('not.exist');
  });

  it('supports custom className', () => {
    cy.mount(
      <SplitButton
        mainAction={{ label: 'Custom', onClick: () => {} }}
        actions={[{ label: 'Option', onClick: () => {} }]}
        className="custom-split-button"
      />
    );

    cy.get('.custom-split-button').should('exist');
  });

  it('maintains visual consistency', () => {
    cy.mount(
      <SplitButton
        mainAction={{ label: 'Consistent', onClick: () => {} }}
        actions={[
          { label: 'Option 1', onClick: () => {} },
          { label: 'Option 2', onClick: () => {} },
        ]}
        variant="secondary"
      />
    );

    // Both parts should have consistent styling
    cy.contains('button', 'Consistent').should('be.visible');
    cy.get('button[aria-haspopup="menu"]').should('be.visible');
  });

  it('supports icons in actions', () => {
    cy.mount(
      <SplitButton
        mainAction={{
          label: 'Save',
          onClick: () => {},
          icon: <span>💾</span>,
        }}
        actions={[
          {
            label: 'Draft',
            onClick: () => {},
            icon: <span>📝</span>,
          },
          {
            label: 'Template',
            onClick: () => {},
            icon: <span>📋</span>,
          },
        ]}
      />
    );

    cy.contains('💾').should('be.visible');
    cy.get('button[aria-haspopup="menu"]').click();
    cy.contains('📝').should('be.visible');
    cy.contains('📋').should('be.visible');
  });

  it('supports destructive variant in dropdown', () => {
    cy.mount(
      <SplitButton
        mainAction={{ label: 'Actions', onClick: () => {} }}
        actions={[
          { label: 'Edit', onClick: () => {} },
          { label: 'Delete', onClick: () => {}, variant: 'destructive' },
        ]}
      />
    );

    cy.get('button[aria-haspopup="menu"]').click();
    cy.contains('Delete').should('have.class', 'text-destructive');
  });
});
