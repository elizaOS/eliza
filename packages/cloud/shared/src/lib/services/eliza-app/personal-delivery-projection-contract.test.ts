/** Verifies opaque sender projection addressing and eviction behavior. */

import { describe, expect, mock, test } from "bun:test";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import {
  invalidatePersonalDeliveryProjection,
  personalDeliveryProjectionObjectName,
} from "./personal-delivery-projection-contract";

describe("personal delivery projection contract", () => {
  test("uses one stable object name per platform sender", () => {
    const telegram = personalDeliveryProjectionObjectName("telegram", " 123456 ");
    expect(telegram).toBe(personalDeliveryProjectionObjectName("telegram", "123456"));
    expect(telegram).toMatch(/^sender:[0-9a-f-]{36}$/);
    expect(telegram).not.toContain("123456");
    expect(telegram).not.toBe(personalDeliveryProjectionObjectName("discord", "123456"));
  });

  test("sends an explicit invalidation to the bound sender object", async () => {
    const fetch = mock(async () => Response.json({ success: true }));
    const getByName = mock(() => ({ fetch }));

    await invalidatePersonalDeliveryProjection(
      { getByName } as unknown as RuntimeDurableObjectNamespace,
      "telegram",
      "123456",
    );

    expect(getByName).toHaveBeenCalledWith(
      personalDeliveryProjectionObjectName("telegram", "123456"),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("fails closed when the projection cannot confirm invalidation", async () => {
    const namespace = {
      getByName: () => ({
        fetch: async () => Response.json({ error: "unavailable" }, { status: 503 }),
      }),
    };

    await expect(
      invalidatePersonalDeliveryProjection(
        namespace as unknown as RuntimeDurableObjectNamespace,
        "telegram",
        "123456",
      ),
    ).rejects.toThrow("projection invalidation failed with status 503");
  });

  test("lets non-Worker writers omit invalidation because it is performance-only", async () => {
    await expect(
      invalidatePersonalDeliveryProjection(undefined, "telegram", "123456"),
    ).resolves.toBeUndefined();
  });
});
