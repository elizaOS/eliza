/// <reference types="cypress" />
/// <reference path="../../../cypress/support/types.d.ts" />

import React from 'react';
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from './toast';

describe('Toast Component', () => {
  it('renders basic toast correctly', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport />
        <Toast open>
          <ToastTitle>Notification</ToastTitle>
          <ToastDescription>This is a toast message</ToastDescription>
        </Toast>
      </ToastProvider>
    );

    cy.contains('Notification').should('be.visible');
    cy.contains('This is a toast message').should('be.visible');
  });

  it('renders with action button', () => {
    const onAction = cy.stub();

    cy.mountRadix(
      <ToastProvider>
        <ToastViewport />
        <Toast open>
          <ToastTitle>Undo</ToastTitle>
          <ToastDescription>Your action has been undone</ToastDescription>
          <ToastAction altText="Redo" onClick={onAction}>
            Redo
          </ToastAction>
        </Toast>
      </ToastProvider>
    );

    cy.contains('button', 'Redo').click();
    cy.wrap(onAction).should('have.been.called');
  });

  it('renders with close button', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport />
        <Toast open>
          <ToastTitle>Success</ToastTitle>
          <ToastDescription>Your changes have been saved</ToastDescription>
          <ToastClose />
        </Toast>
      </ToastProvider>
    );

    cy.get('button[type="button"]').should('exist');
  });

  it('supports different variants', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport />
        <div className="space-y-4">
          <Toast open variant="default">
            <ToastTitle>Default Toast</ToastTitle>
            <ToastDescription>This is a default toast</ToastDescription>
          </Toast>
          <Toast open variant="destructive">
            <ToastTitle>Error</ToastTitle>
            <ToastDescription>Something went wrong</ToastDescription>
          </Toast>
        </div>
      </ToastProvider>
    );

    cy.get('[data-state="open"]').should('have.class', 'destructive');
  });

  it('renders multiple toasts', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport />
        <div>
          <Toast open>
            <ToastTitle>First Toast</ToastTitle>
            <ToastDescription>First message</ToastDescription>
          </Toast>
          <Toast open>
            <ToastTitle>Second Toast</ToastTitle>
            <ToastDescription>Second message</ToastDescription>
          </Toast>
        </div>
      </ToastProvider>
    );

    cy.contains('First Toast').should('be.visible');
    cy.contains('Second Toast').should('be.visible');
  });

  it('handles long content gracefully', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport />
        <Toast open>
          <ToastTitle>Long Title That Should Wrap Properly</ToastTitle>
          <ToastDescription>
            This is a very long description that contains a lot of text. It should wrap properly
            within the toast container and maintain good readability. The toast component should
            handle long content gracefully without breaking the layout.
          </ToastDescription>
        </Toast>
      </ToastProvider>
    );

    cy.get('[data-state="open"]').should('be.visible');
  });

  it('works with custom className', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport className="custom-viewport" />
        <Toast open className="custom-toast bg-blue-500">
          <ToastTitle className="text-white">Custom Styled</ToastTitle>
          <ToastDescription className="text-blue-100">Custom styled toast</ToastDescription>
        </Toast>
      </ToastProvider>
    );

    cy.get('[data-state="open"]').should('have.class', 'custom-toast');
    cy.get('[data-state="open"]').should('have.class', 'bg-blue-500');
  });

  it('supports icons in toast', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport />
        <Toast open>
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div>
              <ToastTitle>Success</ToastTitle>
              <ToastDescription>Operation completed successfully</ToastDescription>
            </div>
          </div>
        </Toast>
      </ToastProvider>
    );

    cy.get('svg').should('be.visible');
    cy.contains('Success').should('be.visible');
  });

  it('renders error toast variant', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport />
        <Toast open variant="destructive">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div>
              <ToastTitle>Error</ToastTitle>
              <ToastDescription>Failed to save changes</ToastDescription>
            </div>
          </div>
          <ToastClose />
        </Toast>
      </ToastProvider>
    );

    cy.contains('Error').should('be.visible');
    cy.contains('Failed to save changes').should('be.visible');
    cy.get('button[type="button"]').should('exist');
  });

  it('viewport positions toast correctly', () => {
    cy.mountRadix(
      <ToastProvider>
        <ToastViewport className="top-0 right-0" />
        <Toast open>
          <ToastTitle>Positioned Toast</ToastTitle>
          <ToastDescription>This toast is positioned</ToastDescription>
        </Toast>
      </ToastProvider>
    );

    cy.get('[data-state="open"]').should('be.visible');
  });
});
