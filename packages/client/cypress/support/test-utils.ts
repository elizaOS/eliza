import type { Agent, UUID } from '@elizaos/core';
import { AgentStatus } from '@elizaos/core';
import * as crypto from 'crypto';

// Helper function to generate a secure random string
const generateSecureRandomString = (length: number): string => {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => (byte % 36).toString(36)).join('');
};

export const generateMockAgent = (overrides?: Partial<Agent>): Agent => {
  const id = overrides?.id || generateUUID();
  const name = overrides?.name || `Test Agent ${generateSecureRandomString(7)}`;

  return {
    id,
    name,
    username: overrides?.username || name.toLowerCase().replace(/\s/g, ''),
    bio: overrides?.bio || 'This is a test agent',
    messageExamples: overrides?.messageExamples || [],
    postExamples: overrides?.postExamples || [],
    topics: overrides?.topics || ['testing', 'automation'],
    adjectives: overrides?.adjectives || ['helpful', 'friendly'],
    knowledge: overrides?.knowledge || [],
    plugins: overrides?.plugins || [],
    settings: overrides?.settings || {
      avatar: 'https://via.placeholder.com/150',
    },
    secrets: overrides?.secrets || {},
    style: overrides?.style || {},
    system: overrides?.system,
    templates: overrides?.templates || {},
    enabled: overrides?.enabled ?? true,
    status: overrides?.status || AgentStatus.INACTIVE,
    createdAt: overrides?.createdAt || Date.now(),
    updatedAt: overrides?.updatedAt || Date.now(),
    ...overrides,
  };
};

// Generate valid UUID
export const generateUUID = (): UUID => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }) as UUID;
};

// API response mocks
export const mockAPIResponses = {
  agents: {
    success: (agents: Agent[] = []) => ({
      statusCode: 200,
      body: { agents, success: true },
    }),
    error: (message = 'Server error') => ({
      statusCode: 500,
      body: { error: message, success: false },
    }),
  },
  messages: {
    success: (messages: any[] = []) => ({
      statusCode: 200,
      body: { messages, success: true },
    }),
    error: (message = 'Failed to load messages') => ({
      statusCode: 500,
      body: { error: message, success: false },
    }),
  },
};

// WebSocket mock helpers
export const mockWebSocket = {
  setup: () => {
    cy.window().then((win) => {
      (win as any).socket = {
        connected: true,
        emit: cy.stub().as('socketEmit'),
        on: cy.stub().as('socketOn'),
        disconnect: cy.stub().as('socketDisconnect'),
        connect: cy.stub().as('socketConnect'),
      };
    });
  },

  disconnect: () => {
    cy.window().then((win) => {
      if ((win as any).socket) {
        (win as any).socket.connected = false;
        (win as any).socket.disconnect();
      }
    });
  },

  emit: (event: string, data: any) => {
    cy.window().then((win) => {
      if ((win as any).socket?.emit) {
        (win as any).socket.emit(event, data);
      }
    });
  },
};

// Common intercepts
export const setupCommonIntercepts = () => {
  // API endpoints
  cy.intercept('GET', '/api/agents', mockAPIResponses.agents.success()).as('getAgents');
  cy.intercept('GET', '/api/agents/*', mockAPIResponses.agents.success()).as('getAgent');
  cy.intercept('POST', '/api/agents', { statusCode: 201, body: { success: true } }).as(
    'createAgent'
  );
  cy.intercept('PUT', '/api/agents/*', { statusCode: 200, body: { success: true } }).as(
    'updateAgent'
  );
  cy.intercept('DELETE', '/api/agents/*', { statusCode: 200, body: { success: true } }).as(
    'deleteAgent'
  );

  // WebSocket
  cy.intercept('GET', '/socket.io/*', { statusCode: 200 }).as('socketConnection');
};

// Wait helpers
export const waitForElement = (selector: string, timeout = 10000) => {
  return cy.get(selector, { timeout }).should('exist');
};

export const waitForElementToDisappear = (selector: string, timeout = 10000) => {
  return cy.get(selector, { timeout }).should('not.exist');
};

// Form helpers
export const fillForm = (fields: Record<string, string>) => {
  Object.entries(fields).forEach(([name, value]) => {
    cy.get(`[name="${name}"]`).clear().type(value);
  });
};

// Assertion helpers
export const assertToast = (message: string, type: 'success' | 'error' = 'success') => {
  cy.get('[data-testid="toast"]')
    .should('be.visible')
    .should('contain.text', message)
    .should('have.class', `toast-${type}`);
};

// Navigation helpers
export const navigateTo = (path: string) => {
  cy.visit(path);
  cy.waitForApp();
};

// Screenshot helpers
export const takeScreenshot = (name: string, options?: Partial<Cypress.ScreenshotOptions>) => {
  cy.screenshot(name, {
    capture: 'viewport',
    overwrite: true,
    ...options,
  });
};

// Accessibility helpers
export const checkA11y = (context?: string | Node | Cypress.Chainable, options?: any) => {
  // This would use cypress-axe if installed
  // cy.injectAxe();
  // cy.checkA11y(context, options);
};

// Visual regression helpers
export const compareSnapshot = (name: string, threshold = 0.1) => {
  // This would use a visual regression plugin
  takeScreenshot(`visual-regression/${name}`);
};
