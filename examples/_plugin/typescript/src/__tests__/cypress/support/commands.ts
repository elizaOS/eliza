/// <reference types="cypress" />
/// <reference types="@cypress/react" />

// ***********************************************
// This file is where you can create custom Cypress commands
// and overwrite existing commands.
//
// For comprehensive examples, visit:
// https://on.cypress.io/custom-commands
// ***********************************************

// Example custom command
// Cypress.Commands.add('login', (email, password) => { ... })

type ElizaConfig = {
  agentId: string;
  apiBase?: string;
};

// Custom command to check if element is in dark mode
Cypress.Commands.add("shouldBeDarkMode", () => {
  return cy.get("html").should("have.class", "dark");
});

// Custom command to set ELIZA_CONFIG
Cypress.Commands.add("setElizaConfig", (config: ElizaConfig) => {
  return cy.window().then((win) => {
    win.ELIZA_CONFIG = config;
    return win;
  });
});

// TypeScript definitions
declare global {
  interface Window {
    ELIZA_CONFIG?: ElizaConfig;
  }

  namespace Cypress {
    interface Chainable {
      shouldBeDarkMode(): Chainable<JQuery<HTMLElement>>;
      setElizaConfig(config: ElizaConfig): Chainable<Window>;
    }
  }
}

export {};
