// ***********************************************************
// This file is processed and loaded automatically before your test files.
// You can change the location of this file or turn off processing using the
// 'supportFile' config option.
// ***********************************************************

// Import commands.js using ES2015 syntax:
import "./commands";

// Import Testing Library Cypress commands
import "@testing-library/cypress/add-commands";

// Import styles
import "../../../frontend/index.css";

import { mount } from "@cypress/react";
import type { ReactElement } from "react";

type MountReturn = ReturnType<typeof mount>;

// Add custom TypeScript types
declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Custom command to mount React components
       * @example cy.mount(<Component />)
       */
      mount(component: ReactElement): MountReturn;
    }
  }
}

// Make mount available globally
Cypress.Commands.add("mount", mount);
