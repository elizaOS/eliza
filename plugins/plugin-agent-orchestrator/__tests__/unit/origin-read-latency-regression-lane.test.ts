/**
 * Runs originating-request and ACP session reads in separate test-file scope
 * from provider framework mocks.
 */
import { expect, it } from "vitest";
import "./get-acp-service-order.test";
import "./originating-request-routing.test";
import "./wait-for-spawn-slot.test";
import "../../src/__tests__/provider-session-read.test";

it("loads the origin-read latency regression matrix", () => {
  expect(true).toBe(true);
});
