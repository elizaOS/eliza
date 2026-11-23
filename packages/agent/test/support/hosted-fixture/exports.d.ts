import type * as HostedFixture from "./index.ts";

declare global {
  type AgentHostedFixtureExports = typeof HostedFixture;
}
