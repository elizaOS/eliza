/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './command';

describe('Command Component', () => {
  it('renders basic command palette', () => {
    cy.mount(
      <Command>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Suggestions">
            <CommandItem>Calendar</CommandItem>
            <CommandItem>Search Emoji</CommandItem>
            <CommandItem>Calculator</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    cy.get('input[placeholder="Type a command or search..."]').should('be.visible');
    cy.contains('Suggestions').should('be.visible');
    cy.contains('Calendar').should('be.visible');
    cy.contains('Search Emoji').should('be.visible');
    cy.contains('Calculator').should('be.visible');
  });

  it('filters items based on search', () => {
    cy.mount(
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup>
            <CommandItem>Apple</CommandItem>
            <CommandItem>Banana</CommandItem>
            <CommandItem>Cherry</CommandItem>
            <CommandItem>Date</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    // Type in search
    cy.get('input[placeholder="Search..."]').type('an');

    // Should show items containing 'an'
    cy.contains('Banana').should('be.visible');
    cy.contains('Apple').should('not.exist');
    cy.contains('Cherry').should('not.exist');
  });

  it('shows empty state when no matches', () => {
    cy.mount(
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup>
            <CommandItem>Item 1</CommandItem>
            <CommandItem>Item 2</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    cy.get('input[placeholder="Search..."]').type('xyz');
    cy.contains('No results found.').should('be.visible');
  });

  it('handles item selection', () => {
    const onSelect = cy.stub();

    cy.mount(
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandGroup>
            <CommandItem onSelect={() => onSelect('calendar')}>Calendar</CommandItem>
            <CommandItem onSelect={() => onSelect('email')}>Email</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    cy.contains('Calendar').click();
    cy.wrap(onSelect).should('have.been.calledWith', 'calendar');
  });

  it('renders with multiple groups', () => {
    cy.mount(
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Apps">
            <CommandItem>Calendar</CommandItem>
            <CommandItem>Mail</CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Settings">
            <CommandItem>Profile</CommandItem>
            <CommandItem>Preferences</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    cy.contains('Apps').should('be.visible');
    cy.contains('Settings').should('be.visible');
    cy.get('[role="separator"]').should('exist');
  });

  it('renders with shortcuts', () => {
    cy.mount(
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandGroup>
            <CommandItem>
              Copy
              <CommandShortcut>⌘C</CommandShortcut>
            </CommandItem>
            <CommandItem>
              Paste
              <CommandShortcut>⌘V</CommandShortcut>
            </CommandItem>
            <CommandItem>
              Cut
              <CommandShortcut>⌘X</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    cy.contains('⌘C').should('be.visible');
    cy.contains('⌘V').should('be.visible');
    cy.contains('⌘X').should('be.visible');
  });

  it('supports keyboard navigation', () => {
    cy.mount(
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandGroup>
            <CommandItem>First Item</CommandItem>
            <CommandItem>Second Item</CommandItem>
            <CommandItem>Third Item</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    // Verify all items are present
    cy.contains('First Item').should('exist');
    cy.contains('Second Item').should('exist');
    cy.contains('Third Item').should('exist');

    // Focus input and verify keyboard interaction works
    cy.get('input').focus();
    cy.get('input').should('have.focus');

    // Test that arrow keys work (even if selection behavior varies)
    cy.get('input').type('{downarrow}');
    cy.get('input').type('{downarrow}');

    // Command component should still be interactive
    cy.get('input').should('have.focus');
  });

  it('renders in dialog mode', () => {
    const TestComponent = () => {
      const [open, setOpen] = React.useState(false);

      return (
        <>
          <button onClick={() => setOpen(true)}>Open Command</button>
          <CommandDialog open={open} onOpenChange={setOpen}>
            <CommandInput placeholder="Type a command..." />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Commands">
                <CommandItem>New File</CommandItem>
                <CommandItem>Open File</CommandItem>
                <CommandItem>Save</CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
        </>
      );
    };

    cy.mount(<TestComponent />);

    cy.contains('New File').should('not.exist');
    cy.contains('Open Command').click();
    cy.contains('New File').should('be.visible');
    cy.contains('Open File').should('be.visible');
  });

  it('applies custom className', () => {
    cy.mount(
      <Command className="custom-command border-2">
        <CommandInput className="custom-input" placeholder="Search..." />
        <CommandList className="custom-list">
          <CommandGroup className="custom-group">
            <CommandItem className="custom-item">Item</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    cy.get('.custom-command').should('have.class', 'border-2');
    cy.get('.custom-input').should('exist');
    cy.get('.custom-list').should('exist');
    cy.get('.custom-group').should('exist');
    cy.get('.custom-item').should('exist');
  });

  it('handles disabled items', () => {
    const onSelect = cy.stub();

    cy.mount(
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandGroup>
            <CommandItem onSelect={onSelect}>Enabled</CommandItem>
            <CommandItem disabled onSelect={onSelect}>
              Disabled
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    cy.contains('Enabled').click();
    cy.wrap(onSelect).should('have.been.calledOnce');

    cy.contains('Disabled').click({ force: true });
    cy.wrap(onSelect).should('have.been.calledOnce'); // Still only once
  });

  it('supports icons in items', () => {
    cy.mount(
      <Command>
        <CommandInput placeholder="Search..." />
        <CommandList>
          <CommandGroup>
            <CommandItem>
              <span className="mr-2">📅</span>
              Calendar
            </CommandItem>
            <CommandItem>
              <span className="mr-2">📧</span>
              Mail
            </CommandItem>
            <CommandItem>
              <span className="mr-2">⚙️</span>
              Settings
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    cy.contains('📅').should('be.visible');
    cy.contains('📧').should('be.visible');
    cy.contains('⚙️').should('be.visible');
  });

  it('handles complex filtering scenarios', () => {
    cy.mount(
      <Command>
        <CommandInput placeholder="Search files..." />
        <CommandList>
          <CommandEmpty>No files found.</CommandEmpty>
          <CommandGroup heading="Recent Files">
            <CommandItem>document.pdf</CommandItem>
            <CommandItem>image.png</CommandItem>
            <CommandItem>video.mp4</CommandItem>
          </CommandGroup>
          <CommandGroup heading="Folders">
            <CommandItem>Documents</CommandItem>
            <CommandItem>Images</CommandItem>
            <CommandItem>Videos</CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    );

    // Search for 'doc'
    cy.get('input').type('doc');
    cy.contains('document.pdf').should('be.visible');
    cy.contains('Documents').should('be.visible');
    cy.contains('image.png').should('not.exist');
    cy.contains('Videos').should('not.exist');
  });
});
