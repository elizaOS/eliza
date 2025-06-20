/// <reference types="cypress" />
/// <reference types="@testing-library/cypress" />

// ***********************************************************
// This example support/e2e.ts is processed and
// loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************

// Import commands.js using ES2015 syntax:
import './commands';
import 'cypress-real-events/support';
import '@testing-library/cypress/add-commands';

// Alternatively you can use CommonJS syntax:
// require('./commands')

// Hide fetch/XHR requests from command log to reduce noise
const app = window.top;
if (app && !app.document.head.querySelector('[data-hide-command-log-request]')) {
  const style = app.document.createElement('style');
  style.innerHTML = '.command-name-request, .command-name-xhr { display: none }';
  style.setAttribute('data-hide-command-log-request', '');
  app.document.head.appendChild(style);
}

// Prevent Cypress from failing tests on uncaught exceptions
Cypress.on('uncaught:exception', (err, runnable) => {
  // Return false to prevent the error from failing the test
  // You might want to log these errors for debugging
  console.error('Uncaught exception:', err);
  return false;
});

// Custom error handling for WebSocket errors
Cypress.on('window:before:load', (win) => {
  // Stub console methods to prevent noise in tests
  win.console.error = (...args) => {
    if (args[0]?.includes?.('WebSocket') || args[0]?.includes?.('Socket')) {
      return; // Suppress WebSocket errors
    }
    console.error(...args);
  };
});

// TypeScript declarations are in ./commands.ts

// Ensure this file is treated as a module
export {};
