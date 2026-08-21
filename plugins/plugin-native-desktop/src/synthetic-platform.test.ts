// @vitest-environment jsdom

/**
 * Runs the production DesktopWeb permission client against the resettable
 * synthetic native host while keeping device certification out of this lane.
 */
import {
  bootInProcessWorld,
  SYNTHETIC_WORLD_SCHEMA_VERSION,
  SyntheticNativePlatform,
} from "@elizaos/synthetic-world";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopPermissionState } from "./definitions.ts";
import { DesktopWeb } from "./web.ts";

const surfaceId = "@elizaos/capacitor-desktop:native-bridge:desktop";

function harness(namespace: string) {
  const world = bootInProcessWorld(
    {
      schemaVersion: SYNTHETIC_WORLD_SCHEMA_VERSION,
      worldId: "native-desktop-permissions",
      seed: "native-desktop-permissions-v1",
      clock: { epoch: "2030-01-01T08:00:00.000Z", timezone: "UTC" },
      fixturePolicy: {
        allowedEmailDomains: ["example.invalid"],
        allowedUrlHosts: ["example.invalid"],
      },
      data: {},
      faults: [],
    },
    { namespace },
  );
  const platform = new SyntheticNativePlatform(world, [
    {
      id: surfaceId,
      initialState: { permission: "granted" },
      handlers: {
        permissionsCheck: (input, context) => ({
          id: (input as { id: string }).id,
          status: (context.state as { permission: string }).permission,
          canRequest: false,
          lastChecked: context.now.getTime(),
          platform: "darwin",
        }),
      },
    },
  ]);
  const request = async (params?: unknown) =>
    platform.invoke({
      surfaceId,
      method: "permissionsCheck",
      input: (params ?? null) as never,
    });
  Object.defineProperty(window, "__ELIZA_ELECTROBUN_RPC__", {
    configurable: true,
    value: { request: { permissionsCheck: request } },
  });
  return { world, platform };
}

afterEach(() => {
  Reflect.deleteProperty(window, "__ELIZA_ELECTROBUN_RPC__");
});

describe("DesktopWeb synthetic native host", () => {
  it("uses the production bridge client and records authoritative readback", async () => {
    const { world, platform } = harness("native:desktop:success");
    const client = new DesktopWeb();
    await expect(client.checkPermission({ id: "camera" })).resolves.toEqual({
      id: "camera",
      status: "granted",
      canRequest: false,
      lastChecked: new Date("2030-01-01T08:00:00.000Z").getTime(),
      platform: "darwin",
    } satisfies DesktopPermissionState);
    expect(world.ledger.byKind("request")).toHaveLength(1);
    expect(world.ledger.byKind("readback")).toHaveLength(1);
    expect(platform.readback().certification).toBe("synthetic-simulator-only");
    platform.teardown();
    world.teardown();
  });

  it("does not turn native unavailability into a successful receipt", async () => {
    const { world, platform } = harness("native:desktop:unavailable");
    platform.setAvailable(surfaceId, false);
    const client = new DesktopWeb();
    await expect(
      client.checkPermission({ id: "camera" }),
    ).rejects.toMatchObject({ code: "platform-unavailable" });
    expect(world.ledger.byKind("readback")).toHaveLength(0);
    platform.teardown();
    world.teardown();
  });
});
