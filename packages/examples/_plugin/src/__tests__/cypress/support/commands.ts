/// <reference types="cypress" />
/// <reference types="@testing-library/cypress" />

Cypress.Commands.add("shouldBeDarkMode", () => {
  cy.get("html").should("have.class", "dark");
});

type ElizaConfig = { agentId: string; apiBase?: string };

Cypress.Commands.add("setElizaConfig", (config: ElizaConfig) => {
  cy.window().then((win) => {
    interface WindowWithElizaConfig extends Window {
      ELIZA_CONFIG?: ElizaConfig;
    }
    (win as WindowWithElizaConfig).ELIZA_CONFIG = config;
  });
});

declare global {
  namespace Cypress {
    interface Chainable {
      shouldBeDarkMode(): Chainable<JQuery<HTMLElement>>;
      setElizaConfig(config: ElizaConfig): Chainable<Window>;
    }
  }
}

export {};
