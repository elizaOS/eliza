import { expect, test } from "bun:test";
import { createApiKeySchema, updateApiKeySchema } from "../v1/api-keys/schemas";

test("API key quotas reject coerced booleans and collections but retain numeric form input", () => {
  for (const schema of [createApiKeySchema, updateApiKeySchema]) {
    for (const rate_limit of [
      true,
      false,
      [10],
      null,
      "",
      "0",
      "100001",
      "1.5",
    ]) {
      expect(schema.safeParse({ name: "Key", rate_limit }).success).toBe(false);
    }
    for (const rate_limit of [1, 100000, "1000"]) {
      expect(schema.parse({ name: "Key", rate_limit }).rate_limit).toBe(
        Number(rate_limit),
      );
    }
  }
  expect(createApiKeySchema.parse({ name: "Key" }).rate_limit).toBe(1000);
  expect(updateApiKeySchema.parse({ name: "Key" }).rate_limit).toBeUndefined();
});
