/** Shared test runtime type used by all live e2e tests. */
export type RuntimeHarness = {
  port: number;
  close: () => Promise<void>;
  logs: () => string;
};
