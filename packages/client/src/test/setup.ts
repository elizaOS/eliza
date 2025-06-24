// Test setup file for Bun:test
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterEach, beforeEach, expect, mock } from 'bun:test';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

// Import React to access internal state
import React from 'react';

// Set up DOM environment with Happy DOM (recommended by Bun)
GlobalRegistrator.register();

// Extend expect with jest-dom matchers
expect.extend(matchers);

// Create a comprehensive localStorage mock
const createLocalStorageMock = () => {
  const store: Record<string, string> = {};

  return {
    getItem: (key: string): string | null => {
      return store[key] || null;
    },
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      delete store[key];
    },
    clear: (): void => {
      Object.keys(store).forEach((key) => delete store[key]);
    },
    get length(): number {
      return Object.keys(store).length;
    },
    key: (index: number): string | null => {
      const keys = Object.keys(store);
      return keys[index] || null;
    },
  };
};

// Set up fresh localStorage and sessionStorage for each test
beforeEach(() => {
  // Create fresh storage instances for each test
  Object.defineProperty(window, 'localStorage', {
    value: createLocalStorageMock(),
    writable: true,
    configurable: true,
  });

  Object.defineProperty(window, 'sessionStorage', {
    value: createLocalStorageMock(),
    writable: true,
    configurable: true,
  });

  // Reset window dimensions to default
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: 1500,
  });

  Object.defineProperty(window, 'innerHeight', {
    writable: true,
    configurable: true,
    value: 900,
  });
});

// Clean up after each test
afterEach(() => {
  cleanup();

  // Clear storage but don't reset the implementation
  if (window.localStorage) {
    window.localStorage.clear();
  }
  if (window.sessionStorage) {
    window.sessionStorage.clear();
  }

  // Force React to clear any cached hook state
  // This helps prevent cross-test contamination when running multiple test files
  if ((React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED) {
    const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
    if (internals.ReactCurrentDispatcher) {
      internals.ReactCurrentDispatcher.current = null;
    }
    if (internals.ReactCurrentBatchConfig) {
      internals.ReactCurrentBatchConfig.transition = null;
    }
  }
});

// React 19 specific setup - add missing APIs for testing-library compatibility
try {
  const React = require('react');

  // Add React.createRef polyfill for React 19 compatibility with testing-library
  if (!React.createRef) {
    React.createRef = function createRef() {
      return { current: null };
    };
  }
} catch (e) {
  console.warn('Failed to set up React internals:', e instanceof Error ? e.message : String(e));
}

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// Mock IntersectionObserver
global.IntersectionObserver = class MockIntersectionObserver {
  root = null;
  rootMargin = '';
  thresholds = [];

  constructor() {}
  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
} as any;

// Mock ResizeObserver
global.ResizeObserver = class MockResizeObserver {
  constructor() {}
  observe() {}
  disconnect() {}
  unobserve() {}
} as any;

// Mock scrollTo for window and elements
window.scrollTo = mock();
Element.prototype.scrollTo = mock();
Element.prototype.scrollIntoView = mock();

// Add any other global test setup here
