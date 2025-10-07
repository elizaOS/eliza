/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Label } from './label';

describe('Label Component', () => {
  it('renders correctly with default props', () => {
    cy.mount(<Label>Email Address</Label>);

    cy.get('label').should('exist');
    cy.get('label').should('contain', 'Email Address');
    cy.get('label').should('have.class', 'text-sm');
    cy.get('label').should('have.class', 'font-normal');
  });

  it('associates with form controls using htmlFor', () => {
    cy.mount(
      <div>
        <Label htmlFor="email-input">Email</Label>
        <input id="email-input" type="email" />
      </div>
    );

    cy.get('label').should('have.attr', 'for', 'email-input');
    // Clicking the label should focus the input
    cy.get('label').click();
    cy.get('#email-input').should('have.focus');
  });

  it('applies custom className', () => {
    cy.mount(<Label className="custom-label text-lg">Custom Label</Label>);

    cy.get('label').should('have.class', 'custom-label').should('have.class', 'text-lg');
  });

  it('renders with required indicator', () => {
    cy.mount(
      <Label>
        Username <span className="text-red-500">*</span>
      </Label>
    );

    cy.get('label').should('contain', 'Username');
    cy.get('label').find('.text-red-500').should('contain', '*');
  });

  it('works with checkbox inputs', () => {
    cy.mount(
      <div className="flex items-center space-x-2">
        <input type="checkbox" id="terms" />
        <Label htmlFor="terms">Accept terms and conditions</Label>
      </div>
    );

    cy.get('label').click();
    cy.get('#terms').should('be.checked');
  });

  it('works with radio inputs', () => {
    cy.mount(
      <div className="space-y-2">
        <div className="flex items-center space-x-2">
          <input type="radio" id="option1" name="options" />
          <Label htmlFor="option1">Option 1</Label>
        </div>
        <div className="flex items-center space-x-2">
          <input type="radio" id="option2" name="options" />
          <Label htmlFor="option2">Option 2</Label>
        </div>
      </div>
    );

    cy.get('label').first().click();
    cy.get('#option1').should('be.checked');
    cy.get('#option2').should('not.be.checked');

    cy.get('label').last().click();
    cy.get('#option1').should('not.be.checked');
    cy.get('#option2').should('be.checked');
  });

  it('supports disabled state styling', () => {
    cy.mount(<Label className="peer-disabled:opacity-50">Disabled Label</Label>);

    cy.get('label').should('have.class', 'peer-disabled:opacity-50');
  });

  it('renders in a form layout', () => {
    cy.mount(
      <form className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <input id="name" type="text" className="w-full border rounded px-2 py-1" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <input id="email" type="email" className="w-full border rounded px-2 py-1" />
        </div>
      </form>
    );

    cy.get('label').should('have.length', 2);
    cy.get('label').first().should('contain', 'Name');
    cy.get('label').last().should('contain', 'Email');
  });

  it('supports custom styles', () => {
    cy.mount(
      <Label className="text-blue-600 uppercase tracking-wide" style={{ fontSize: '14px' }}>
        Styled Label
      </Label>
    );

    cy.get('label')
      .should('have.class', 'text-blue-600')
      .should('have.class', 'uppercase')
      .should('have.class', 'tracking-wide')
      .should('have.css', 'font-size', '14px');
  });

  it('works with nested content', () => {
    cy.mount(
      <Label>
        <span className="font-bold">Bold part</span> normal part
      </Label>
    );

    cy.get('label').find('.font-bold').should('contain', 'Bold part');
    cy.get('label').should('contain', 'normal part');
  });

  it('supports data attributes', () => {
    cy.mount(
      <Label data-testid="custom-label" data-field="username">
        Username
      </Label>
    );

    cy.get('[data-testid="custom-label"]')
      .should('exist')
      .should('have.attr', 'data-field', 'username');
  });

  it('maintains proper spacing in form groups', () => {
    cy.mount(
      <div className="space-y-1">
        <Label htmlFor="field">Field Label</Label>
        <input id="field" className="w-full" />
        <p className="text-sm text-gray-500">Helper text</p>
      </div>
    );

    cy.get('label').should('be.visible');
    cy.get('.space-y-1').should('exist');
  });
});
