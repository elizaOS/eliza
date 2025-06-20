/// <reference types="cypress" />
/// <reference types="@testing-library/cypress" />
/// <reference types="@cypress/react" />

import { MountOptions, MountReturn } from '@cypress/react';

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
      // Custom commands are declared in ./commands.ts
    }
  }
}

// Import statements to ensure types are available
import { mount } from 'cypress/react';
import type { mountWithRouter, mountRadix } from './component';

export {};
