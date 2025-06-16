/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
} from './dropdown-menu';
import { Button } from './button';

describe('DropdownMenu Component', () => {
  it('renders basic dropdown menu', () => {
    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Open Menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuItem>Item 2</DropdownMenuItem>
          <DropdownMenuItem>Item 3</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').contains('Open Menu').should('exist');
    cy.get('button').click();
    cy.contains('Item 1').should('be.visible');
    cy.contains('Item 2').should('be.visible');
    cy.contains('Item 3').should('be.visible');
  });

  it('handles menu item clicks', () => {
    const onClick = cy.stub();

    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={onClick}>Action 1</DropdownMenuItem>
          <DropdownMenuItem>Action 2</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').click();
    cy.contains('Action 1').click();
    cy.wrap(onClick).should('have.been.called');
  });

  it('renders with labels and separators', () => {
    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Options</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>Account</DropdownMenuLabel>
          <DropdownMenuItem>Profile</DropdownMenuItem>
          <DropdownMenuItem>Settings</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem>Log out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').click();
    cy.contains('Account').should('be.visible');
    cy.contains('Profile').should('be.visible');
    cy.get('[role="separator"]').should('exist');
  });

  it('supports disabled items', () => {
    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Enabled</DropdownMenuItem>
          <DropdownMenuItem disabled>Disabled</DropdownMenuItem>
          <DropdownMenuItem>Also Enabled</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').click();
    cy.contains('Disabled').should('have.attr', 'data-disabled');
  });

  it('renders checkbox items', () => {
    const CheckboxTestComponent = () => {
      const [checked, setChecked] = React.useState(false);

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>Settings</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuCheckboxItem checked={checked} onCheckedChange={setChecked}>
              Show Status Bar
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem>Show Activity Bar</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    };

    cy.mountRadix(<CheckboxTestComponent />);

    cy.get('button').click();
    cy.contains('Show Status Bar').click();
    cy.contains('Show Status Bar').should('have.attr', 'data-state', 'checked');
  });

  it('renders radio group items', () => {
    const RadioTestComponent = () => {
      const [value, setValue] = React.useState('option1');

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>View</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value={value} onValueChange={setValue}>
              <DropdownMenuRadioItem value="option1">Option 1</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="option2">Option 2</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="option3">Option 3</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    };

    cy.mountRadix(<RadioTestComponent />);

    cy.get('button').click();
    cy.contains('Option 1').should('have.attr', 'data-state', 'checked');
    cy.contains('Option 2').click();
    cy.contains('Option 2').should('have.attr', 'data-state', 'checked');
  });

  it('supports sub menus', () => {
    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>New File</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More Tools</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Save Page As...</DropdownMenuItem>
              <DropdownMenuItem>Create Shortcut...</DropdownMenuItem>
              <DropdownMenuItem>Name Window...</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').click();
    cy.contains('More Tools').should('be.visible');

    // Try clicking instead of hover for submenu
    cy.contains('More Tools').click();
    cy.contains('Save Page As...').should('be.visible');
  });

  it('renders with shortcuts', () => {
    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Edit</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>
            Undo
            <DropdownMenuShortcut>⌘Z</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            Redo
            <DropdownMenuShortcut>⇧⌘Z</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').click();
    cy.contains('⌘Z').should('be.visible');
    cy.contains('⇧⌘Z').should('be.visible');
  });

  it('supports custom className', () => {
    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Styled</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuItem className="text-red-500">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').click();
    cy.get('[role="menu"]').should('have.class', 'w-56');
    cy.contains('Delete').should('have.class', 'text-red-500');
  });

  it('closes on escape key', () => {
    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item 1</DropdownMenuItem>
          <DropdownMenuItem>Item 2</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').click();
    cy.contains('Item 1').should('be.visible');
    cy.get('body').type('{esc}');
    cy.contains('Item 1').should('not.exist');
  });

  it('supports grouped items', () => {
    cy.mountRadix(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Grouped</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Group 1</DropdownMenuLabel>
            <DropdownMenuItem>Item 1</DropdownMenuItem>
            <DropdownMenuItem>Item 2</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Group 2</DropdownMenuLabel>
            <DropdownMenuItem>Item 3</DropdownMenuItem>
            <DropdownMenuItem>Item 4</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    cy.get('button').click();
    cy.contains('Group 1').should('be.visible');
    cy.contains('Group 2').should('be.visible');
  });
});
