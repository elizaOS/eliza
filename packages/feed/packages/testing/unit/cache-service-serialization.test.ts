import { describe, expect, test } from "bun:test";
import {
  parseCacheValue,
  serializeCacheValue,
} from "../../api/src/cache/cache-service";

describe("cache-service bigint serialization", () => {
  test("round-trips nested bigint values through cache serialization", () => {
    const payload = {
      id: "user-1",
      largeNumber: 1234567890123456789n,
      nested: {
        gasUsed: 21000n,
      },
      values: [1n, 2n, 3n],
    };

    const serialized = serializeCacheValue(payload);
    const parsed = parseCacheValue<typeof payload>(serialized);

    expect(parsed).toEqual(payload);
    expect(typeof parsed.largeNumber).toBe("bigint");
    expect(typeof parsed.nested.gasUsed).toBe("bigint");
    expect(typeof parsed.values[0]).toBe("bigint");
  });

  test("keeps ordinary JSON payloads unchanged", () => {
    const payload = {
      id: "user-2",
      createdAt: "2026-04-07T11:35:04.013Z",
      points: 42,
    };

    const serialized = serializeCacheValue(payload);
    const parsed = parseCacheValue<typeof payload>(serialized);

    expect(parsed).toEqual(payload);
  });
});
