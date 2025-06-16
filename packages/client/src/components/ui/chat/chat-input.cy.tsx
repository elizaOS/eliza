/// <reference types="cypress" />
/// <reference path="../../../../cypress/support/types.d.ts" />

import React from 'react';
import { ChatInput } from './chat-input';

// Test component for form submission
const TestForm = () => {
  const [value, setValue] = React.useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValue('');
  };

  return (
    <form onSubmit={handleSubmit}>
      <ChatInput value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit">Send</button>
    </form>
  );
};

// Test component for chat form
const TestChatForm = () => {
  const [messages, setMessages] = React.useState<string[]>([]);
  const [input, setInput] = React.useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      setMessages([...messages, input]);
      setInput('');
    }
  };

  return (
    <div>
      <div className="messages">
        {messages.map((msg, i) => (
          <div key={i}>{msg}</div>
        ))}
      </div>
      <form onSubmit={handleSubmit}>
        <ChatInput
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
};

describe('ChatInput Component', () => {
  it('renders correctly with default props', () => {
    cy.mount(<ChatInput placeholder="Type a message..." />);

    cy.get('textarea').should('exist');
    cy.get('textarea').should('have.attr', 'placeholder', 'Type a message...');
    cy.get('textarea').should('have.attr', 'name', 'message');
    cy.get('textarea').should('have.class', 'resize-none');
  });

  it('accepts user input', () => {
    cy.mount(<ChatInput />);

    cy.get('textarea').type('Hello, this is a test message');
    cy.get('textarea').should('have.value', 'Hello, this is a test message');
  });

  it('applies custom placeholder', () => {
    cy.mount(<ChatInput placeholder="Write your message here..." />);

    cy.get('textarea').should('have.attr', 'placeholder', 'Write your message here...');
  });

  it('handles onChange events', () => {
    const onChange = cy.stub();
    cy.mount(<ChatInput onChange={onChange} />);

    cy.get('textarea').type('Test');
    cy.wrap(onChange).should('have.been.called');
  });

  it('handles onKeyDown events', () => {
    const onKeyDown = cy.stub();
    cy.mount(<ChatInput onKeyDown={onKeyDown} />);

    cy.get('textarea').type('{enter}');
    cy.wrap(onKeyDown).should('have.been.called');
  });

  it('can be disabled', () => {
    cy.mount(<ChatInput disabled />);

    cy.get('textarea').should('be.disabled');
    cy.get('textarea').should('have.class', 'disabled:cursor-not-allowed');
    cy.get('textarea').should('have.class', 'disabled:opacity-50');
  });

  it('applies custom className', () => {
    cy.mount(<ChatInput className="custom-class" />);

    cy.get('textarea').should('have.class', 'custom-class');
  });

  it('clears input on submit', () => {
    cy.mount(<TestForm />);

    cy.get('textarea').type('Test message');
    cy.get('textarea').should('have.value', 'Test message');
    cy.get('button').click();
    cy.get('textarea').should('have.value', '');
  });

  it('works with autoComplete', () => {
    cy.mount(<ChatInput autoComplete="on" />);

    cy.get('textarea').should('have.attr', 'autocomplete', 'on');
  });

  it('supports maxLength', () => {
    cy.mount(<ChatInput maxLength={100} />);

    cy.get('textarea').should('have.attr', 'maxlength', '100');
  });

  it('maintains focus after mount', () => {
    cy.mount(<ChatInput autoFocus />);

    cy.get('textarea').should('have.focus');
  });

  it('handles paste events', () => {
    const onPaste = cy.stub();
    cy.mount(<ChatInput onPaste={onPaste} />);

    cy.get('textarea').trigger('paste');
    cy.wrap(onPaste).should('have.been.called');
  });

  it('supports different input modes', () => {
    cy.mount(<ChatInput inputMode="text" />);

    cy.get('textarea').should('have.attr', 'inputmode', 'text');
  });

  it('works in a chat form', () => {
    cy.mount(<TestChatForm />);

    cy.get('textarea').type('First message');
    cy.get('button').click();
    cy.get('.messages').should('contain', 'First message');
    cy.get('textarea').should('have.value', '');

    cy.get('textarea').type('Second message');
    cy.get('button').click();
    cy.get('.messages').should('contain', 'Second message');
  });

  it('supports data attributes', () => {
    cy.mount(<ChatInput data-testid="chat-input" data-cy="chat-input" />);

    cy.get('[data-testid="chat-input"]').should('exist');
    cy.get('[data-cy="chat-input"]').should('exist');
  });
});
