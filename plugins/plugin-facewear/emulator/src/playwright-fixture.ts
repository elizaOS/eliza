/**
 * Re-export of the canonical Playwright XR fixture (issue #9941 — one harness).
 * The source of truth — `XREmulatorPage`, `test`/`expect`, `MockAgentServer`,
 * pose/controller/hand injection, 3D telemetry — lives in
 * `@elizaos/plugin-xr/simulator`. Do not fork it here.
 */
export * from "../../../plugin-xr/simulator/src/playwright-fixture.ts";
