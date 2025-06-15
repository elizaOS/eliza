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
      /**
       * Mounts a React component with all common providers (QueryClient, Router)
       */
      mount(component: React.ReactNode, options?: MountOptions): Chainable<MountReturn>;
      
      /**
       * Mounts a React component with just Router provider
       */
      mountWithRouter(component: React.ReactNode, options?: MountOptions): Chainable<MountReturn>;
      
      /**
       * Mounts a React component specifically for Radix UI components with DirectionProvider
       */
      mountRadix(component: React.ReactNode, options?: MountOptions): Chainable<MountReturn>;
      
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