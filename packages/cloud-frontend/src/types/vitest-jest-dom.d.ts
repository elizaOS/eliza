import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";
import "vitest";

declare module "vitest" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchersContaining
    extends TestingLibraryMatchers<unknown, void> {}
}
