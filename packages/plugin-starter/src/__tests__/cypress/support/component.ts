// ***********************************************************
// This file is processed and loaded automatically before your test files.
// You can change the location of this file or turn off processing using the
// 'supportFile' config option.
// ***********************************************************

// Import commands.js using ES2015 syntax:
import './commands';

// Import Testing Library Cypress commands
import '@testing-library/cypress/add-commands';

// Import styles
import '../../../frontend/index.css';

// Add custom TypeScript types
declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Custom command to mount React components
       * @example cy.mount(<Component />)
       */
      mount(component: React.ReactElement): Chainable<any>;
    }
  }
}

// Import React mount function
import { mount } from '@cypress/react';

// Make mount available globally
Cypress.Commands.add('mount', mount);
