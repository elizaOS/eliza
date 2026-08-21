/**
 * Deterministic contracts verify sensitive identifiers are removed before
 * either plain-text or structured request telemetry receives a path.
 */

import { expect, test } from "bun:test";
import { redactSensitiveRequestPath } from "./request-path-redaction";

test("legacy push-token paths are redacted before request logging", () => {
  const raw =
    "--> DELETE /api/v1/eliza/agents/personal/api/notifications/push-tokens/device-secret?trace=1";
  expect(redactSensitiveRequestPath(raw)).toBe(
    "--> DELETE /api/v1/eliza/agents/personal/api/notifications/push-tokens/[redacted]?trace=1",
  );
});

test("exact body-based push-token paths and unrelated paths are unchanged", () => {
  expect(redactSensitiveRequestPath("/api/notifications/push-tokens")).toBe(
    "/api/notifications/push-tokens",
  );
  expect(redactSensitiveRequestPath("/api/i18n/locale")).toBe(
    "/api/i18n/locale",
  );
});
