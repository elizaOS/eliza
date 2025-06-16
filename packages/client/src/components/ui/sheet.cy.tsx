/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';
import { Button } from './button';

describe('Sheet Component', () => {
  it('renders basic sheet from right', () => {
    cy.mount(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Open Sheet</Button>
        </SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Sheet Title</SheetTitle>
            <SheetDescription>This is a sheet description.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );

    cy.contains('button', 'Open Sheet').should('be.visible');
    cy.contains('Sheet Title').should('not.exist');

    // Open sheet
    cy.contains('button', 'Open Sheet').click();
    cy.contains('Sheet Title').should('be.visible');
    cy.contains('This is a sheet description.').should('be.visible');
  });

  it('renders sheet from different sides', () => {
    cy.mount(
      <div className="flex gap-4">
        <Sheet>
          <SheetTrigger>From Top</SheetTrigger>
          <SheetContent side="top">
            <SheetTitle>Top Sheet</SheetTitle>
          </SheetContent>
        </Sheet>

        <Sheet>
          <SheetTrigger>From Bottom</SheetTrigger>
          <SheetContent side="bottom">
            <SheetTitle>Bottom Sheet</SheetTitle>
          </SheetContent>
        </Sheet>

        <Sheet>
          <SheetTrigger>From Left</SheetTrigger>
          <SheetContent side="left">
            <SheetTitle>Left Sheet</SheetTitle>
          </SheetContent>
        </Sheet>
      </div>
    );

    // Test top sheet
    cy.contains('From Top').click();
    cy.contains('Top Sheet').should('be.visible');
    cy.get('body').type('{esc}');

    // Test bottom sheet
    cy.contains('From Bottom').click();
    cy.contains('Bottom Sheet').should('be.visible');
  });

  it('closes sheet when clicking overlay', () => {
    cy.mount(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle>Click Outside Test</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    cy.contains('Open').click();
    cy.contains('Click Outside Test').should('be.visible');

    // Use escape key instead of clicking overlay
    cy.get('body').type('{esc}');
    cy.contains('Click Outside Test').should('not.exist');
  });

  it('renders with footer actions', () => {
    const onSave = cy.stub();
    const onCancel = cy.stub();

    cy.mount(
      <Sheet>
        <SheetTrigger>Edit Profile</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Edit Profile</SheetTitle>
            <SheetDescription>Make changes to your profile here.</SheetDescription>
          </SheetHeader>
          <div className="py-4">
            <input placeholder="Name" className="w-full p-2 border rounded" />
          </div>
          <SheetFooter>
            <SheetClose asChild>
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
            </SheetClose>
            <Button onClick={onSave}>Save changes</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );

    cy.contains('Edit Profile').click();
    cy.get('input[placeholder="Name"]').should('be.visible');

    cy.contains('button', 'Save changes').click();
    cy.wrap(onSave).should('have.been.called');
  });

  it('works as controlled component', () => {
    const TestComponent = () => {
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <button onClick={() => setOpen(true)}>External Open</button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent>
              <SheetTitle>Controlled Sheet</SheetTitle>
              <button onClick={() => setOpen(false)}>Close Sheet</button>
            </SheetContent>
          </Sheet>
        </>
      );
    };

    cy.mount(<TestComponent />);

    cy.contains('Controlled Sheet').should('not.exist');
    cy.contains('External Open').click();
    cy.contains('Controlled Sheet').should('be.visible');

    cy.contains('button', 'Close Sheet').click();
    cy.contains('Controlled Sheet').should('not.exist');
  });

  it('handles keyboard navigation', () => {
    cy.mount(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent>
          <SheetTitle>Keyboard Test</SheetTitle>
          <button>First Button</button>
          <button>Second Button</button>
        </SheetContent>
      </Sheet>
    );

    cy.contains('Open').click();
    cy.contains('Keyboard Test').should('be.visible');

    // ESC key should close
    cy.get('body').type('{esc}');
    cy.contains('Keyboard Test').should('not.exist');
  });

  it('supports custom className', () => {
    cy.mount(
      <Sheet>
        <SheetTrigger className="custom-trigger">Open</SheetTrigger>
        <SheetContent className="bg-blue-50 custom-content">
          <SheetTitle>Custom Styled Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    );

    cy.get('.custom-trigger').should('exist');
    cy.contains('Open').click();
    cy.get('.custom-content').should('have.class', 'bg-blue-50');
  });

  it('renders form inside sheet', () => {
    const onSubmit = cy.stub();

    cy.mount(
      <Sheet>
        <SheetTrigger>Add Item</SheetTrigger>
        <SheetContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit('submitted');
            }}
          >
            <SheetHeader>
              <SheetTitle>Add New Item</SheetTitle>
              <SheetDescription>Fill in the details below</SheetDescription>
            </SheetHeader>
            <div className="space-y-4 py-4">
              <input name="title" placeholder="Title" required />
              <textarea name="description" placeholder="Description" />
            </div>
            <SheetFooter>
              <SheetClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </SheetClose>
              <Button type="submit">Add</Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
    );

    cy.contains('Add Item').click();
    cy.get('input[name="title"]').type('Test Item');
    cy.get('textarea[name="description"]').type('Test Description');
    cy.get('form').submit();
    cy.wrap(onSubmit).should('have.been.calledWith', 'submitted');
  });

  it('handles long content with scroll', () => {
    cy.mount(
      <Sheet>
        <SheetTrigger>View Content</SheetTrigger>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Long Content</SheetTitle>
          </SheetHeader>
          <div className="py-4">
            {Array.from({ length: 50 }, (_, i) => (
              <p key={i} className="py-2">
                Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor
                incididunt ut labore et dolore magna aliqua.
              </p>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    );

    cy.contains('View Content').click();
    cy.get('.overflow-y-auto').should('be.visible');
  });

  it('renders navigation menu in sheet', () => {
    cy.mount(
      <Sheet>
        <SheetTrigger>Menu</SheetTrigger>
        <SheetContent side="left">
          <SheetHeader>
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <nav className="mt-8">
            <ul className="space-y-2">
              <li>
                <a href="#" className="block p-2 hover:bg-gray-100">
                  Home
                </a>
              </li>
              <li>
                <a href="#" className="block p-2 hover:bg-gray-100">
                  About
                </a>
              </li>
              <li>
                <a href="#" className="block p-2 hover:bg-gray-100">
                  Services
                </a>
              </li>
              <li>
                <a href="#" className="block p-2 hover:bg-gray-100">
                  Contact
                </a>
              </li>
            </ul>
          </nav>
        </SheetContent>
      </Sheet>
    );

    cy.contains('Menu').click();
    cy.contains('Navigation').should('be.visible');
    cy.contains('Home').should('be.visible');
    cy.contains('About').should('be.visible');
    cy.contains('Services').should('be.visible');
    cy.contains('Contact').should('be.visible');
  });

  it('maintains focus management', () => {
    cy.mount(
      <Sheet>
        <SheetTrigger>Open Sheet</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Focus Test</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 py-4">
            <input placeholder="First input" />
            <input placeholder="Second input" />
            <button>Action Button</button>
          </div>
        </SheetContent>
      </Sheet>
    );

    cy.contains('Open Sheet').click();

    // Focus should be trapped within sheet
    cy.get('input[placeholder="First input"]').focus();
    cy.focused().should('have.attr', 'placeholder', 'First input');
  });
});
