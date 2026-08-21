/** Verifies sender projection addressing and the fail-closed invalidation boundary. */

import { describe, expect, mock, test } from "bun:test";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import {
  invalidatePersonalDeliveryProjection,
  personalDeliveryProjectionObjectName,
} from "./personal-delivery-projection-contract";

describe("personal delivery projection contract", () => {
  test("uses one stable object name per platform sender", () => {
    expect(personalDeliveryProjectionObjectName("telegram", " 123456 ")).toBe("telegram:123456");
    expect(personalDeliveryProjectionObjectName("discord", "987654")).toBe("discord:987654");
    expect(personalDeliveryProjectionObjectName("phone", " +15551234567 ")).toBe(
      "phone:+15551234567",
    );
  });

  test("sends an explicit invalidation to the bound sender object", async () => {
    const fetch = mock(async () => Response.json({ success: true }));
    const getByName = mock(() => ({ fetch }));

    await invalidatePersonalDeliveryProjection(
      { getByName } as unknown as RuntimeDurableObjectNamespace,
      "telegram",
      "123456",
    );

    expect(getByName).toHaveBeenCalledWith("telegram:123456");
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
});
