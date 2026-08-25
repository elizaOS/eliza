/** Verifies sender projection addressing and the fail-closed invalidation boundary. */

import { describe, expect, mock, test } from "bun:test";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";
import {
  invalidatePersonalDeliveryProjection,
  personalDeliveryProjectionObjectName,
  runWithBoundPersonalDeliveryProjectionFences,
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

  test("fences every distinct sender before the mutation and releases afterward", async () => {
    const events: string[] = [];
    const tokens = new Set<string>();
    const namespace = {
      getByName: (name: string) => ({
        fetch: async (url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { token: string };
          tokens.add(body.token);
          events.push(`${new URL(url).pathname}:${name}`);
          return Response.json({ success: true });
        },
      }),
    } as unknown as RuntimeDurableObjectNamespace;

    const result = await runWithCloudBindingsAsync(
      { PERSONAL_DELIVERY_PROJECTIONS: namespace },
      () =>
        runWithBoundPersonalDeliveryProjectionFences(
          [
            { platform: "telegram", platformUserId: "123456" },
            { platform: "phone", platformUserId: "+15551234567" },
            { platform: "telegram", platformUserId: "123456" },
          ],
          async () => {
            events.push("mutation");
            return "committed";
          },
        ),
    );

    expect(result).toBe("committed");
    expect(tokens.size).toBe(1);
    expect(events).toEqual([
      "/fence:phone:+15551234567",
      "/fence:telegram:123456",
      "mutation",
      "/release:phone:+15551234567",
      "/release:telegram:123456",
    ]);
  });

  test("aborts the mutation and releases acquired fences after an acquisition failure", async () => {
    const events: string[] = [];
    const operation = mock(async () => "must-not-run");
    const namespace = {
      getByName: (name: string) => ({
        fetch: async (url: string) => {
          const path = new URL(url).pathname;
          events.push(`${path}:${name}`);
          if (path === "/fence" && name.startsWith("phone:")) {
            return Response.json({ error: "unavailable" }, { status: 503 });
          }
          return Response.json({ success: true });
        },
      }),
    } as unknown as RuntimeDurableObjectNamespace;

    await expect(
      runWithCloudBindingsAsync({ PERSONAL_DELIVERY_PROJECTIONS: namespace }, () =>
        runWithBoundPersonalDeliveryProjectionFences(
          [
            { platform: "discord", platformUserId: "987654" },
            { platform: "phone", platformUserId: "+15551234567" },
          ],
          operation,
        ),
      ),
    ).rejects.toThrow("projection fence failed with status 503");

    expect(operation).not.toHaveBeenCalled();
    expect(events).toEqual([
      "/fence:discord:987654",
      "/fence:phone:+15551234567",
      "/release:discord:987654",
    ]);
  });

  test("releases acquired fences when the canonical mutation fails", async () => {
    const events: string[] = [];
    const namespace = {
      getByName: (name: string) => ({
        fetch: async (url: string) => {
          events.push(`${new URL(url).pathname}:${name}`);
          return Response.json({ success: true });
        },
      }),
    } as unknown as RuntimeDurableObjectNamespace;

    await expect(
      runWithCloudBindingsAsync({ PERSONAL_DELIVERY_PROJECTIONS: namespace }, () =>
        runWithBoundPersonalDeliveryProjectionFences(
          [{ platform: "phone", platformUserId: "+15551234567" }],
          async () => {
            events.push("mutation");
            throw new Error("database rejected mutation");
          },
        ),
      ),
    ).rejects.toThrow("database rejected mutation");

    expect(events).toEqual([
      "/fence:phone:+15551234567",
      "mutation",
      "/release:phone:+15551234567",
    ]);
  });

  test("surfaces a release failure after the canonical mutation commits", async () => {
    const events: string[] = [];
    const namespace = {
      getByName: (name: string) => ({
        fetch: async (url: string) => {
          const path = new URL(url).pathname;
          events.push(`${path}:${name}`);
          if (path === "/release") {
            return Response.json({ error: "unavailable" }, { status: 503 });
          }
          return Response.json({ success: true });
        },
      }),
    } as unknown as RuntimeDurableObjectNamespace;

    await expect(
      runWithCloudBindingsAsync({ PERSONAL_DELIVERY_PROJECTIONS: namespace }, () =>
        runWithBoundPersonalDeliveryProjectionFences(
          [{ platform: "phone", platformUserId: "+15551234567" }],
          async () => {
            events.push("mutation");
            return "committed";
          },
        ),
      ),
    ).rejects.toThrow("projection release failed with status 503");

    expect(events).toEqual([
      "/fence:phone:+15551234567",
      "mutation",
      "/release:phone:+15551234567",
    ]);
  });
});
