/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Input } from './input';

describe('Input Component', () => {
  it('renders correctly', () => {
    cy.mount(<Input placeholder="Enter text" />);

    cy.get('input').should('exist');
    cy.get('input').should('have.attr', 'placeholder', 'Enter text');
  });

  it('accepts user input', () => {
    cy.mount(<Input />);

    const testText = 'Hello, World!';
    cy.get('input').type(testText);
    cy.get('input').should('have.value', testText);
  });

  it('can be disabled', () => {
    cy.mount(<Input disabled />);

    cy.get('input').should('be.disabled');
  });

  it('accepts different types', () => {
    const types = ['text', 'email', 'password', 'number'] as const;

    types.forEach((type) => {
      cy.mount(<Input type={type} />);
      cy.get('input').should('have.attr', 'type', type);
    });
  });

  it('applies custom className', () => {
    cy.mount(<Input className="custom-class bg-red-500" />);

    cy.get('input').should('have.class', 'custom-class');
    cy.get('input').should('have.class', 'bg-red-500');
  });

  it('handles onChange events', () => {
    const onChange = cy.stub();

    cy.mount(<Input onChange={onChange} />);

    cy.get('input').type('test');
    cy.wrap(onChange).should('have.been.called');
  });

  it('forwards ref correctly', () => {
    // Test that ref prop is accepted without errors
    const ref = React.createRef<HTMLInputElement>();
    cy.mount(<Input ref={ref} data-testid="ref-input" />);

    // Verify the input is rendered
    cy.get('[data-testid="ref-input"]').should('exist');
  });

  it('supports readonly state', () => {
    cy.mount(<Input readOnly value="Read only text" />);

    cy.get('input').should('have.attr', 'readonly');
    cy.get('input').should('have.value', 'Read only text');
  });

  it('supports max length', () => {
    cy.mount(<Input maxLength={10} />);

    cy.get('input').type('This is a very long text');
    cy.get('input').should('have.value', 'This is a ');
  });

  it('supports autoComplete', () => {
    cy.mount(<Input autoComplete="email" />);

    cy.get('input').should('have.attr', 'autocomplete', 'email');
  });
});
