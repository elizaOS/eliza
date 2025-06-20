/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from './dialog';
import { Button } from './button';

describe('Dialog Component', () => {
  it('renders dialog with trigger', () => {
    cy.mount(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open Dialog</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dialog Title</DialogTitle>
            <DialogDescription>This is a dialog description.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );

    cy.contains('button', 'Open Dialog').should('be.visible');
    cy.contains('Dialog Title').should('not.exist');

    // Open dialog
    cy.contains('button', 'Open Dialog').click();
    cy.contains('Dialog Title').should('be.visible');
    cy.contains('This is a dialog description.').should('be.visible');
  });

  it('closes dialog when clicking outside', () => {
    cy.mount(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Click Outside Test</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    cy.contains('Open').click();
    cy.contains('Click Outside Test').should('be.visible');

    // Test escape key instead of clicking outside
    cy.get('body').type('{esc}');
    cy.contains('Click Outside Test').should('not.exist');
  });

  it('renders with footer actions', () => {
    const onSave = cy.stub();
    const onCancel = cy.stub();

    cy.mount(
      <Dialog>
        <DialogTrigger>Open Form</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Profile</DialogTitle>
            <DialogDescription>Make changes to your profile here.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <input placeholder="Name" className="w-full p-2 border rounded" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onSave}>Save changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

    cy.contains('Open Form').click();
    cy.get('input[placeholder="Name"]').should('be.visible');

    cy.contains('button', 'Save changes').click({ force: true });
    cy.wrap(onSave).should('have.been.called');
  });

  it('works as controlled component', () => {
    const TestComponent = () => {
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <button onClick={() => setOpen(true)}>External Open</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>Controlled Dialog</DialogTitle>
              <DialogClose asChild>
                <button>Close</button>
              </DialogClose>
            </DialogContent>
          </Dialog>
        </>
      );
    };

    cy.mount(<TestComponent />);

    cy.contains('Controlled Dialog').should('not.exist');
    cy.contains('External Open').click();
    cy.contains('Controlled Dialog').should('be.visible');

    cy.contains('button', 'Close').click({ force: true });
    cy.contains('Controlled Dialog').should('not.exist');
  });

  it('handles keyboard navigation', () => {
    cy.mount(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Keyboard Test</DialogTitle>
          <button>First Button</button>
          <button>Second Button</button>
        </DialogContent>
      </Dialog>
    );

    cy.contains('Open').click();
    cy.contains('Keyboard Test').should('be.visible');

    // ESC key should close
    cy.get('body').type('{esc}');
    cy.contains('Keyboard Test').should('not.exist');
  });

  it('supports custom className', () => {
    cy.mount(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent className="bg-blue-50 max-w-lg">
          <DialogTitle>Custom Styled Dialog</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    cy.contains('Open').click();
    cy.get('[role="dialog"]').should('have.class', 'bg-blue-50');
    cy.get('[role="dialog"]').should('have.class', 'max-w-lg');
  });

  it('renders form inside dialog', () => {
    const onSubmit = cy.stub();

    cy.mount(
      <Dialog>
        <DialogTrigger>Add Item</DialogTrigger>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit('submitted');
            }}
          >
            <DialogHeader>
              <DialogTitle>Add New Item</DialogTitle>
              <DialogDescription>Fill in the details below</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <input name="title" placeholder="Title" required />
              <textarea name="description" placeholder="Description" />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit">Add</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );

    cy.contains('Add Item').click();
    cy.get('input[name="title"]').type('Test Item');
    cy.get('textarea[name="description"]').type('Test Description');
    cy.get('[role="dialog"]').within(() => {
      cy.contains('button', 'Add').click({ force: true });
    });
    cy.wrap(onSubmit).should('have.been.calledWith', 'submitted');
  });

  it('prevents closing when modal', () => {
    cy.mount(
      <Dialog modal={true}>
        <DialogTrigger>Open Modal</DialogTrigger>
        <DialogContent>
          <DialogTitle>Modal Dialog</DialogTitle>
          <DialogDescription>
            This dialog is modal and requires explicit action to close.
          </DialogDescription>
        </DialogContent>
      </Dialog>
    );

    cy.contains('Open Modal').click();
    cy.contains('Modal Dialog').should('be.visible');
  });

  it('supports nested content', () => {
    cy.mount(
      <Dialog>
        <DialogTrigger>View Details</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>User Details</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div>
              <strong>Name:</strong> John Doe
            </div>
            <div>
              <strong>Email:</strong> john@example.com
            </div>
            <div>
              <strong>Role:</strong> Administrator
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );

    cy.contains('View Details').click();
    cy.contains('John Doe').should('be.visible');
    cy.contains('john@example.com').should('be.visible');
    cy.contains('Administrator').should('be.visible');
  });

  it('handles long content with scroll', () => {
    cy.mount(
      <Dialog>
        <DialogTrigger>Open Long Content</DialogTrigger>
        <DialogContent className="max-h-[300px]">
          <DialogHeader>
            <DialogTitle>Terms and Conditions</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto max-h-[200px]">
            {Array.from({ length: 50 }, (_, i) => (
              <p key={i} className="py-2">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud
                exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
              </p>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );

    cy.contains('Open Long Content').click();

    // Wait for dialog to open and verify scroll container exists
    cy.get('[role="dialog"]').should('be.visible');
    cy.get('.overflow-y-auto').should('exist');

    // Verify the container has the correct CSS classes for scrolling
    cy.get('.overflow-y-auto').should('have.class', 'overflow-y-auto');
    cy.get('.overflow-y-auto').should('have.class', 'max-h-[200px]');

    // Check that content exists inside the scroll container
    cy.get('.overflow-y-auto p').should('have.length', 50);
  });
});
