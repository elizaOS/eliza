/**
 * Stub for @elizaos/computeruse so tests can run without the native binding.
 * Tests that need real Desktop set COMPUTERUSE_DESKTOP_TESTS=1 and have the native build.
 */
function createStubDesktop() {
  return {
    locator: () => ({
      first: async () => null,
    }),
    openApplication: () => {},
    delay: async (_ms: number) => {},
    applications: () => [],
    getWindowTree: () => ({}),
  };
}

export const Desktop = createStubDesktop as any;
export class ElementNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElementNotFoundError";
  }
}
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
