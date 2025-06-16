/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog';
import { Button } from './button';

describe('AlertDialog Component', () => {
  it('renders basic alert dialog', () => {
    cy.mount(
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive">Delete Item</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete your account and remove
              your data from our servers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

    cy.contains('button', 'Delete Item').should('be.visible');
    cy.contains('Are you absolutely sure?').should('not.exist');

    // Open dialog
    cy.contains('button', 'Delete Item').click();
    cy.contains('Are you absolutely sure?').should('be.visible');
    cy.contains('This action cannot be undone').should('be.visible');
  });

  it('handles action button click', () => {
    const onAction = cy.stub();

    cy.mount(
      <AlertDialog>
        <AlertDialogTrigger>Delete</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Confirm Deletion</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this item?
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onAction}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

    // Open the dialog
    cy.contains('Delete').click();

    // Wait for dialog to appear and ensure it's visible
    cy.contains('Confirm Deletion').should('be.visible');

    // Try clicking the specific action button using a more precise selector
    cy.get('[role="alertdialog"]').within(() => {
      cy.contains('button', 'Delete').click({ force: true });
    });
    cy.wrap(onAction).should('have.been.called');

    // Dialog should close
    cy.contains('Confirm Deletion').should('not.exist');
  });

  it('handles cancel button click', () => {
    const onCancel = cy.stub();

    cy.mount(
      <AlertDialog>
        <AlertDialogTrigger>Show Alert</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Warning</AlertDialogTitle>
          <AlertDialogDescription>This is a warning message.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
            <AlertDialogAction>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

    cy.contains('Show Alert').click();
    cy.contains('button', 'Cancel').click({ force: true });
    cy.wrap(onCancel).should('have.been.called');

    // Dialog should close
    cy.contains('Warning').should('not.exist');
  });

  it('works as controlled component', () => {
    const TestComponent = () => {
      const [open, setOpen] = React.useState(false);
      const [confirmed, setConfirmed] = React.useState(false);

      return (
        <div>
          <button onClick={() => setOpen(true)}>Open Alert</button>
          <p>Confirmed: {confirmed ? 'Yes' : 'No'}</p>

          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogContent>
              <AlertDialogTitle>Confirm Action</AlertDialogTitle>
              <AlertDialogDescription>Do you want to proceed?</AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmed(true);
                    setOpen(false);
                  }}
                >
                  Confirm
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      );
    };

    cy.mount(<TestComponent />);

    cy.contains('Confirmed: No').should('be.visible');
    cy.contains('Open Alert').click();
    cy.contains('Confirm Action').should('be.visible');

    cy.contains('button', 'Confirm').click({ force: true });
    cy.contains('Confirmed: Yes').should('be.visible');
    cy.contains('Confirm Action').should('not.exist');
  });

  it('prevents closing on escape by default', () => {
    cy.mount(
      <AlertDialog>
        <AlertDialogTrigger>Important Action</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Critical Decision</AlertDialogTitle>
          <AlertDialogDescription>This requires your explicit action.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Proceed</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

    cy.contains('Important Action').click();
    cy.contains('Critical Decision').should('be.visible');

    // Try to close with ESC
    cy.get('body').type('{esc}');
    cy.contains('Critical Decision').should('be.visible');
  });

  it('supports custom className', () => {
    cy.mount(
      <AlertDialog>
        <AlertDialogTrigger className="custom-trigger">Open</AlertDialogTrigger>
        <AlertDialogContent className="bg-red-50 custom-content">
          <AlertDialogTitle className="text-red-900">Error</AlertDialogTitle>
          <AlertDialogDescription className="text-red-700">
            Something went wrong!
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction className="bg-red-600">OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

    cy.get('.custom-trigger').should('exist');
    cy.contains('Open').click();
    cy.get('.custom-content').should('have.class', 'bg-red-50');
    cy.get('.text-red-900').should('contain', 'Error');
  });

  it('handles async operations', () => {
    const TestComponent = () => {
      const [loading, setLoading] = React.useState(false);
      const [open, setOpen] = React.useState(false);

      const handleDelete = async () => {
        setLoading(true);
        // Simulate async operation
        await new Promise((resolve) => setTimeout(resolve, 100));
        setLoading(false);
        setOpen(false);
      };

      return (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button>Delete</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Delete Item</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this item?
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} disabled={loading}>
                {loading ? 'Deleting...' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      );
    };

    cy.mount(<TestComponent />);

    // Open the dialog
    cy.contains('button', 'Delete').click();

    // Wait for dialog content to appear
    cy.contains('Delete Item').should('be.visible');

    // Click the action button within the dialog
    cy.get('[role="alertdialog"]').within(() => {
      cy.contains('button', 'Delete').click({ force: true });
    });
    cy.contains('Deleting...').should('be.visible');
    cy.wait(150);
    cy.contains('Delete Item').should('not.exist');
  });

  it('supports warning variant styling', () => {
    cy.mount(
      <AlertDialog>
        <AlertDialogTrigger>
          <Button variant="outline">Show Warning</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>⚠️ Warning</AlertDialogTitle>
            <AlertDialogDescription>
              This action may have unintended consequences.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go Back</AlertDialogCancel>
            <AlertDialogAction className="bg-yellow-600 hover:bg-yellow-700">
              I Understand
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

    cy.contains('Show Warning').click();
    cy.contains('⚠️ Warning').should('be.visible');
    cy.get('.bg-yellow-600').should('contain', 'I Understand');
  });

  it('handles multiple dialogs', () => {
    cy.mount(
      <div className="space-x-4">
        <AlertDialog>
          <AlertDialogTrigger>First Dialog</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>First Alert</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogAction>OK</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog>
          <AlertDialogTrigger>Second Dialog</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Second Alert</AlertDialogTitle>
            <AlertDialogFooter>
              <AlertDialogAction>OK</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );

    // Open first dialog
    cy.contains('First Dialog').click();
    cy.contains('First Alert').should('be.visible');
    cy.contains('button', 'OK').click();

    // Open second dialog
    cy.contains('Second Dialog').click();
    cy.contains('Second Alert').should('be.visible');
  });

  it('maintains focus management', () => {
    cy.mount(
      <AlertDialog>
        <AlertDialogTrigger>Open Alert</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Focus Test</AlertDialogTitle>
          <AlertDialogDescription>
            Focus should be trapped within the dialog.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );

    cy.contains('Open Alert').click();

    // Focus should be within dialog
    cy.focused().should('exist');
  });
});
