import { describe, expect, test } from "bun:test";
import {
  getMissingNotificationSchemaErrorCode,
  isMissingNotificationSchemaError,
} from "../../../apps/web/src/app/api/notifications/schema-compat";

describe("notification schema compatibility helpers", () => {
  test("detects direct undefined column errors", () => {
    const error = { code: "42703" };

    expect(getMissingNotificationSchemaErrorCode(error)).toBe("42703");
    expect(isMissingNotificationSchemaError(error)).toBe(true);
  });

  test("detects nested undefined table errors", () => {
    const error = { cause: { code: "42P01" } };

    expect(getMissingNotificationSchemaErrorCode(error)).toBe("42P01");
    expect(isMissingNotificationSchemaError(error)).toBe(true);
  });

  test("ignores unrelated errors", () => {
    const error = { code: "23505" };

    expect(getMissingNotificationSchemaErrorCode(error)).toBeNull();
    expect(isMissingNotificationSchemaError(error)).toBe(false);
  });
});
