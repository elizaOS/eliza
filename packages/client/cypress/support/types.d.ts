/// <reference types="cypress" />
/// <reference types="@testing-library/cypress" />

declare module 'process/browser' {
  const process: NodeJS.Process;
  export = process;
}

// Extend Cypress types
declare global {
  namespace Cypress {
    interface Chainable {
      mount: typeof mount;
      mountWithRouter: typeof mountWithRouter;
      mountRadix: typeof mountRadix;
      waitForApp(): Chainable<void>;
      login(email: string, password: string): Chainable<void>;
      connectWebSocket(): Chainable<void>;
      cleanupTestData(): Chainable<void>;
    }
  }
}

// Import statements to ensure types are available
import { mount } from 'cypress/react';
import type { mountWithRouter, mountRadix } from './component';

export {}; 