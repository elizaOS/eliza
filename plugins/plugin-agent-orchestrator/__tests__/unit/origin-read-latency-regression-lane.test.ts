/**
 * Runs originating-request and ACP session reads in separate test-file scope
 * from provider framework mocks.
 */
import { expect, it } from "vitest";
import "./get-acp-service-order.test";
import "./originating-request-routing.test";
import "./wait-for-spawn-slot.test";
import "../../src/__tests__/provider-session-read.test";
import { getTimeoutMs } from "../../src/actions/common";

it("loads the origin-read latency regression matrix", () => {
  expect(getTimeoutMs({ timeout_ms: 250 }, {})).toBe(250);
  expect(getTimeoutMs({}, {})).toBeUndefined();
});
