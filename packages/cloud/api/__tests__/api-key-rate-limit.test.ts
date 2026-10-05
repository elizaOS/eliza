import { expect, test } from "bun:test";
import { createApiKeySchema, updateApiKeySchema } from "../v1/api-keys/schemas";

test("API-key writes reject nonnumeric JSON types without losing numeric-string support", () => {
  for (const rate_limit of [
    true,
    false,
    null,
    [],
    [1],
    {},
    "",
    "NaN",
    0,
    1.5,
    100001,
  ]) {
    expect(
      createApiKeySchema.safeParse({ name: "key", rate_limit }).success,
    ).toBe(false);
    expect(updateApiKeySchema.safeParse({ rate_limit }).success).toBe(false);
  }
  for (const rate_limit of [1, "1", 100000, "100000"]) {
    expect(
      createApiKeySchema.parse({ name: "key", rate_limit }).rate_limit,
    ).toBe(Number(rate_limit));
    expect(updateApiKeySchema.parse({ rate_limit }).rate_limit).toBe(
      Number(rate_limit),
    );
  }
  expect(createApiKeySchema.parse({ name: "key" }).rate_limit).toBe(1000);
  expect(
    updateApiKeySchema.parse({ name: "renamed" }).rate_limit,
  ).toBeUndefined();
});
