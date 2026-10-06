import { expect, test } from "bun:test";
import { earningsHistoryQuerySchema } from "./history-query";

test("accepts an explicit earnings history limit of 0", () => {
  expect(earningsHistoryQuerySchema.parse({ limit: "0" })).toMatchObject({
    limit: 0,
    offset: 0,
  });
});

test("keeps the default page when limit is omitted", () => {
  expect(earningsHistoryQuerySchema.parse({}).limit).toBe(50);
});

test("rejects a negative earnings history limit", () => {
  expect(earningsHistoryQuerySchema.safeParse({ limit: "-1" }).success).toBe(
    false,
  );
});
