/**
 * Node-side test entry point for the XR Playwright fixture and mock agent
 * server.
 */
export {
  expect,
  MockAgentServer,
  test,
  XREmulatorPage,
} from "./playwright-fixture.ts";
export type { EmulatorStats, XRPose } from "./types.ts";
