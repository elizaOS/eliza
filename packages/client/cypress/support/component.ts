/// <reference types="cypress" />
/// <reference types="@testing-library/cypress" />

// ***********************************************************
// This example support/component.ts is processed and
// loaded automatically before your component test files.

// Import commands.js using ES2015 syntax:
import './commands';
import { mount } from '@cypress/react';
import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@/index.css'; // Import global styles
import { DirectionProvider } from '@radix-ui/react-direction';
import { TooltipProvider } from '@/components/ui/tooltip';
// import { AuthProvider } from '@/context/AuthContext';
// import { ConnectionProvider } from '@/context/ConnectionContext';

// Import polyfills
import { Buffer } from 'buffer';
// @ts-ignore
import process from 'process/browser';

// Mock environment variables to prevent errors
(globalThis as any).process = process;
(globalThis as any).process.env = {
  SENTRY_DSN: '',
  NODE_ENV: 'test',
  ...process.env,
};
(globalThis as any).process.versions = {
  node: '18.0.0',
};

// Add Buffer polyfill globally
(globalThis as any).Buffer = Buffer;
if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer;
}

// Fix for Radix UI components - they need proper React import
if (typeof window !== 'undefined') {
  (window as any).React = React;
}

// Ensure React is properly available globally
if (typeof globalThis !== 'undefined') {
  (globalThis as any).React = React;
}

// Remove duplicate declarations - they're already in types.d.ts

// Create a default query client for tests
const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });

// Mount with all common providers
function mountWithProviders(component: React.ReactNode, options = {}) {
  const queryClient = createTestQueryClient();

  const wrapped = React.createElement(TooltipProvider, {
    children: React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        BrowserRouter,
        {},
        // Add a div container for portals
        React.createElement(
          'div',
          {
            id: 'root',
            style: { width: '100%', height: '100%' },
          },
          component,
          // Portal container for Radix UI
          React.createElement('div', { id: 'radix-portal' })
        )
      )
    ),
  });

  return mount(wrapped, options);
}

// Mount with just router (for simpler components)
function mountWithRouter(component: React.ReactNode, options = {}) {
  const queryClient = createTestQueryClient();

  const wrapped = React.createElement(TooltipProvider, {
    children: React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        BrowserRouter,
        {},
        // Add a div container for portals
        React.createElement(
          'div',
          {
            id: 'root',
            style: { width: '100%', height: '100%' },
          },
          component,
          // Portal container for Radix UI
          React.createElement('div', { id: 'radix-portal' })
        )
      )
    ),
  });

  return mount(wrapped, options);
}

// Mount specifically for Radix UI components with DirectionProvider
function mountRadix(component: React.ReactNode, options = {}) {
  const queryClient = createTestQueryClient();

  const wrapped = React.createElement(TooltipProvider, {
    children: React.createElement(
      DirectionProvider,
      { dir: 'ltr' },
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          BrowserRouter,
          {},
          // Add a div container for portals
          React.createElement(
            'div',
            {
              id: 'root',
              style: { width: '100%', height: '100%' },
            },
            component,
            // Portal container for Radix UI
            React.createElement('div', { id: 'radix-portal' })
          )
        )
      )
    ),
  });

  return mount(wrapped, options);
}

// Add commands
Cypress.Commands.add('mount', mountWithProviders);
Cypress.Commands.add('mountWithRouter', mountWithRouter);
Cypress.Commands.add('mountRadix', mountRadix);

// Example of how to use:
// cy.mount(<Button onClick={handleClick}>Click me</Button>);
// cy.mountWithRouter(<Navigation />);
// cy.mountRadix(<DropdownMenu />);
