/**
 * Runs the development compatibility route matrix together so request-timing
 * persistence remains covered alongside the route catalog and trust boundary.
 */
import { expect, it } from "vitest";
import "./compat-route-chain.test";
import "./compat-route-shared-trust.test";
import "./dev-boot-history.test";
import "./dev-route-catalog.test";
import "./dev-stack.test";
import "./dev-voice-latency-route.test";

it("loads the development compatibility route regression matrix", () => {
  expect(true).toBe(true);
});
