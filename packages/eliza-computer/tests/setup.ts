/**
 * Installs DOM matchers and browser shims shared by component tests.
 */

import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "scrollTo", {
  configurable: true,
  value: () => undefined,
});
