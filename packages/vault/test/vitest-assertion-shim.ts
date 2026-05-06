import "vitest";

declare module "vitest" {
  // biome-ignore lint/suspicious/noExplicitAny: must match Vitest's Assertion generic.
  interface Assertion<T = any> {
    readonly not: Assertion<T>;
  }
}
