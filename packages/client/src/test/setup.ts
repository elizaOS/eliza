// Test setup file for Bun:test
import { JSDOM } from 'jsdom';
import '@testing-library/jest-dom';
import { mock } from 'bun:test';

// Set up DOM environment  
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
  resources: 'usable'
});

// Copy all properties from dom.window to global
Object.assign(global, dom.window);

// Ensure specific properties are set
global.document = dom.window.document;
global.window = dom.window as any;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;

// Additional globals for React testing
global.Text = dom.window.Text;
global.Comment = dom.window.Comment;
global.DocumentFragment = dom.window.DocumentFragment;

// React 19 specific setup - fix React internals
try {
  // Mock ReactDOM internals for React 19 compatibility
  const React = require('react');
  const ReactDOM = require('react-dom/client');
  
  // Create a minimal ReactSharedInternals mock
  if (React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED) {
    const ReactInternals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
    if (!ReactInternals.S) {
      ReactInternals.S = null;
    }
  }
} catch (e) {
  console.warn('Failed to set up React internals:', e.message);
}

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: mock().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: mock(), // deprecated
    removeListener: mock(), // deprecated
    addEventListener: mock(),
    removeEventListener: mock(),
    dispatchEvent: mock(),
  })),
});

// Mock window.ResizeObserver
global.ResizeObserver = mock().mockImplementation(() => ({
  observe: mock(),
  unobserve: mock(),
  disconnect: mock(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = mock().mockImplementation(() => ({
  observe: mock(),
  unobserve: mock(),
  disconnect: mock(),
}));

// Mock scrollTo for window and elements
window.scrollTo = mock();
Element.prototype.scrollTo = mock();
Element.prototype.scrollIntoView = mock();

// Add any other global test setup here
