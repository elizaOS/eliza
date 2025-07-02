/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import { Textarea } from './textarea';

describe('Textarea Component', () => {
  it('renders correctly with default props', () => {
    cy.mount(<Textarea placeholder="Enter your message" />);

    cy.get('textarea').should('exist');
    cy.get('textarea').should('have.attr', 'placeholder', 'Enter your message');
    cy.get('textarea').should('have.class', 'flex');
    cy.get('textarea').should('have.class', 'min-h-[120px]');
  });

  it('accepts user input', () => {
    cy.mount(<Textarea />);

    const testText = 'This is a multiline\ntext input\nwith multiple lines';
    cy.get('textarea').type(testText);
    cy.get('textarea').should('have.value', testText);
  });

  it('can be disabled', () => {
    cy.mount(<Textarea disabled />);

    cy.get('textarea').should('be.disabled');
    cy.get('textarea').should('have.class', 'disabled:cursor-not-allowed');
  });

  it('applies custom className', () => {
    cy.mount(<Textarea className="custom-textarea h-32" />);

    cy.get('textarea').should('have.class', 'custom-textarea').should('have.class', 'h-32');
  });

  it('supports rows attribute', () => {
    cy.mount(<Textarea rows={5} />);

    cy.get('textarea').should('have.attr', 'rows', '5');
  });

  it('supports maxLength', () => {
    cy.mount(<Textarea maxLength={100} />);

    const longText = 'a'.repeat(150);
    cy.get('textarea').type(longText);
    cy.get('textarea').invoke('val').should('have.length', 100);
  });

  it('handles onChange events', () => {
    const onChange = cy.stub();

    cy.mount(<Textarea onChange={onChange} />);

    cy.get('textarea').type('test');
    cy.wrap(onChange).should('have.been.called');
  });

  it('supports readonly state', () => {
    cy.mount(<Textarea readOnly value="Read only text" />);

    cy.get('textarea').should('have.attr', 'readonly');
    cy.get('textarea').should('have.value', 'Read only text');
  });

  it('auto-resizes if configured', () => {
    cy.mount(<Textarea placeholder="Type to see auto-resize" className="resize-none" />);

    cy.get('textarea').should('have.class', 'resize-none');
  });

  it('works with form validation', () => {
    cy.mount(
      <form>
        <Textarea required name="message" />
        <button type="submit">Submit</button>
      </form>
    );

    cy.get('textarea').should('have.attr', 'required');
    cy.get('textarea').should('have.attr', 'name', 'message');
  });

  it('supports data attributes', () => {
    cy.mount(<Textarea data-testid="custom-textarea" data-field="description" />);

    cy.get('[data-testid="custom-textarea"]')
      .should('exist')
      .should('have.attr', 'data-field', 'description');
  });

  it('maintains proper focus states', () => {
    cy.mount(<Textarea />);

    cy.get('textarea').focus();
    cy.get('textarea').should('have.focus');
    cy.get('textarea').should('have.class', 'focus-visible:ring-1');
  });

  it('handles long content properly', () => {
    const longText = Array(10).fill('This is a long line of text.').join('\n');

    cy.mount(<Textarea value={longText} />);

    cy.get('textarea').should('have.value', longText);
    cy.get('textarea').scrollTo(0, 100);
  });

  it('works with labels', () => {
    cy.mount(
      <div className="space-y-2">
        <label htmlFor="comment">Comment</label>
        <Textarea id="comment" />
      </div>
    );

    cy.get('label').click();
    cy.get('#comment').should('have.focus');
  });

  it('supports different sizes via className', () => {
    cy.mount(
      <div className="space-y-4">
        <Textarea className="min-h-[40px]" placeholder="Small" />
        <Textarea className="min-h-[100px]" placeholder="Medium" />
        <Textarea className="min-h-[200px]" placeholder="Large" />
      </div>
    );

    cy.get('textarea').should('have.length', 3);
    cy.get('textarea').first().should('have.class', 'min-h-[40px]');
    cy.get('textarea').last().should('have.class', 'min-h-[200px]');
  });
});
