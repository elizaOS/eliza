/// <reference types="cypress" />
/// <reference types="@testing-library/cypress" />

import "./commands";
import "@testing-library/cypress/add-commands";
import "../../../frontend/index.css";

import { type MountReturn, mount } from "@cypress/react";
import type { ReactElement } from "react";

declare global {
  namespace Cypress {
    interface Chainable {
      mount(component: ReactElement): Chainable<MountReturn>;
    }
  }
}

Cypress.Commands.add("mount", mount);
