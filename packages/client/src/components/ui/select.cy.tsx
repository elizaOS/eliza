/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  SelectSeparator,
} from './select';

describe('Select Component', () => {
  it('renders correctly with default props', () => {
    cy.mount(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select an option" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="option1">Option 1</SelectItem>
          <SelectItem value="option2">Option 2</SelectItem>
          <SelectItem value="option3">Option 3</SelectItem>
        </SelectContent>
      </Select>
    );

    cy.get('[role="combobox"]').should('exist');
    cy.get('[role="combobox"]').should('contain', 'Select an option');
  });

  it('opens and closes dropdown', () => {
    cy.mount(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Choose..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
          <SelectItem value="orange">Orange</SelectItem>
        </SelectContent>
      </Select>
    );

    // Initially closed
    cy.contains('Apple').should('not.exist');

    // Click to open
    cy.get('[role="combobox"]').click();
    cy.contains('Apple').should('be.visible');
    cy.contains('Banana').should('be.visible');
    cy.contains('Orange').should('be.visible');
  });

  it('selects an option', () => {
    cy.mount(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select a fruit" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
          <SelectItem value="orange">Orange</SelectItem>
        </SelectContent>
      </Select>
    );

    cy.get('[role="combobox"]').click();
    cy.contains('Banana').click();
    cy.get('[role="combobox"]').should('contain', 'Banana');
  });

  it('works as controlled component', () => {
    const TestComponent = () => {
      const [value, setValue] = React.useState('');

      return (
        <div>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger>
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">One</SelectItem>
              <SelectItem value="2">Two</SelectItem>
              <SelectItem value="3">Three</SelectItem>
            </SelectContent>
          </Select>
          <p>Selected: {value || 'none'}</p>
        </div>
      );
    };

    cy.mount(<TestComponent />);

    cy.contains('Selected: none').should('exist');
    cy.get('[role="combobox"]').click();
    cy.contains('Two').click();
    cy.contains('Selected: 2').should('exist');
  });

  it('can be disabled', () => {
    cy.mount(
      <Select disabled>
        <SelectTrigger>
          <SelectValue placeholder="Disabled select" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    );

    cy.get('[role="combobox"]').should('have.attr', 'data-disabled');
    cy.get('[role="combobox"]').click({ force: true });
    cy.contains('Option 1').should('not.exist');
  });

  it('supports grouped options', () => {
    cy.mount(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Fruits</SelectLabel>
            <SelectItem value="apple">Apple</SelectItem>
            <SelectItem value="banana">Banana</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Vegetables</SelectLabel>
            <SelectItem value="carrot">Carrot</SelectItem>
            <SelectItem value="lettuce">Lettuce</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );

    cy.get('[role="combobox"]').click();
    cy.contains('Fruits').should('be.visible');
    cy.contains('Vegetables').should('be.visible');
    cy.contains('Apple').should('be.visible');
    cy.contains('Carrot').should('be.visible');
  });

  it('supports custom className', () => {
    cy.mount(
      <Select>
        <SelectTrigger className="w-[200px] custom-select">
          <SelectValue placeholder="Custom styled" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
        </SelectContent>
      </Select>
    );

    cy.get('[role="combobox"]').should('have.class', 'w-[200px]');
    cy.get('[role="combobox"]').should('have.class', 'custom-select');
  });

  it('handles keyboard navigation', () => {
    cy.mount(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Navigate with keyboard" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">First</SelectItem>
          <SelectItem value="2">Second</SelectItem>
          <SelectItem value="3">Third</SelectItem>
        </SelectContent>
      </Select>
    );

    // Open with Enter key
    cy.get('[role="combobox"]').focus();
    cy.get('[role="combobox"]').type('{enter}');
    cy.contains('First').should('be.visible');

    // Navigate with arrow keys
    cy.get('body').type('{downarrow}');
    cy.get('body').type('{downarrow}');
    cy.get('body').type('{enter}');

    cy.get('[role="combobox"]').should('contain', 'Third');
  });

  it('supports disabled items', () => {
    cy.mount(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Some options disabled" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Available</SelectItem>
          <SelectItem value="2" disabled>
            Not Available
          </SelectItem>
          <SelectItem value="3">Also Available</SelectItem>
        </SelectContent>
      </Select>
    );

    cy.get('[role="combobox"]').click();
    cy.get('[data-disabled]').should('contain', 'Not Available');
  });

  it('displays long option text properly', () => {
    cy.mount(
      <Select>
        <SelectTrigger className="w-[300px]">
          <SelectValue placeholder="Long options" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">
            This is a very long option text that should be handled properly
          </SelectItem>
          <SelectItem value="2">Short</SelectItem>
        </SelectContent>
      </Select>
    );

    cy.get('[role="combobox"]').click();
    cy.contains('This is a very long option text').should('be.visible');
  });

  it('works in forms', () => {
    cy.mount(
      <form>
        <label htmlFor="country">Country</label>
        <Select name="country">
          <SelectTrigger id="country">
            <SelectValue placeholder="Select country" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="us">United States</SelectItem>
            <SelectItem value="uk">United Kingdom</SelectItem>
            <SelectItem value="ca">Canada</SelectItem>
          </SelectContent>
        </Select>
      </form>
    );

    cy.get('[role="combobox"]').click();
    cy.get('[role="listbox"]').within(() => {
      cy.contains('United Kingdom').click({ force: true });
    });
    cy.get('[role="combobox"]').should('contain', 'United Kingdom');
  });

  it('maintains focus after selection', () => {
    cy.mount(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Test focus" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Option 1</SelectItem>
          <SelectItem value="2">Option 2</SelectItem>
        </SelectContent>
      </Select>
    );

    cy.get('[role="combobox"]').focus();
    cy.get('[role="combobox"]').click();
    cy.contains('Option 1').click();
    cy.get('[role="combobox"]').should('have.focus');
  });
});
