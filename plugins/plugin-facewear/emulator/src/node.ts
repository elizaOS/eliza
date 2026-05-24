// Node-side entry point — exports the Playwright fixture and mock server.
// Do not import this from browser code.
export {
  expect,
  MockAgentServer,
  test,
  XREmulatorPage,
} from "./playwright-fixture.ts";
export type { EmulatorStats, XRPose } from "./types.ts";
