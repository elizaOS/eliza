/** Pins the dual-binding Telegram edge migration gate to exact-true, fail-closed semantics. */

import { describe, expect, test } from "bun:test";
import { isPersonalSharedTelegramEdgeEnabled } from "./personal-shared-telegram-edge";

describe("Personal Shared Telegram edge gate", () => {
  test.each([
    [{}, false],
    [{ PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "false" }, false],
    [{ PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "true" }, true],
    [
      {
        ENVIRONMENT: "staging",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED: "true",
      },
      true,
    ],
    [
      {
        ENVIRONMENT: "staging",
        PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "false",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED: "true",
      },
      true,
    ],
    [
      {
        ENVIRONMENT: "production",
        PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "false",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED: "true",
      },
      false,
    ],
    [{ PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED: "1" }, false],
    [{ PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED: " true " }, false],
    [
      {
        ENVIRONMENT: "production",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED: "true",
      },
      true,
    ],
    [
      {
        ENVIRONMENT: "production",
        PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED: "false",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED: "true",
      },
      true,
    ],
    [
      {
        ENVIRONMENT: "staging",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED: "true",
      },
      false,
    ],
    [
      { PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED: "true" },
      false,
    ],
    [
      {
        ENVIRONMENT: "production",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED: "1",
      },
      false,
    ],
    [
      {
        ENVIRONMENT: "production",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED: " true ",
      },
      false,
    ],
    [
      {
        ENVIRONMENT: "production",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_ENABLED: "true",
        PERSONAL_SHARED_TELEGRAM_EDGE_CUTOVER_PRODUCTION_ENABLED: "false",
      },
      false,
    ],
  ])("resolves %o as %s", (env, expected) => {
    expect(isPersonalSharedTelegramEdgeEnabled(env)).toBe(expected);
  });
});
