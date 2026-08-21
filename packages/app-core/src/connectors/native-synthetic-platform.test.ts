/**
 * Runs production JSC and QuickJS adapters against the deterministic native
 * simulator; these receipts never claim signed-device certification.
 */
import {
  bootInProcessWorld,
  SYNTHETIC_WORLD_SCHEMA_VERSION,
  SyntheticNativePlatform,
} from "@elizaos/synthetic-world";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CapacitorJscPlugin,
  createCapacitorJscBridge,
} from "./capacitor-jsc.ts";
import {
  type CapacitorQuickJsPlugin,
  createCapacitorQuickJsBridge,
} from "./capacitor-quickjs.ts";

vi.mock("@elizaos/agent", () => ({ registerJsRuntimeFactory: vi.fn() }));

const active: Array<{
  platform: SyntheticNativePlatform;
  world: ReturnType<typeof bootInProcessWorld>;
}> = [];

function boot(namespace: string, surfaceId: string, kind: string) {
  const world = bootInProcessWorld(
    {
      schemaVersion: SYNTHETIC_WORLD_SCHEMA_VERSION,
      worldId: `native-${kind}`,
      seed: `native-${kind}-v1`,
      clock: { epoch: "2030-01-01T08:00:00.000Z", timezone: "UTC" },
      fixturePolicy: {
        allowedEmailDomains: ["example.invalid"],
        allowedUrlHosts: ["example.invalid"],
      },
      data: {
        identities: [],
        organizations: [],
        agents: [],
        rooms: [],
        threads: [],
        messages: [],
        connectorAccounts: [],
        grants: [],
        calendars: [],
        calendarEvents: [],
        tasks: [],
        reminders: [],
        contacts: [],
        relationships: [],
        memories: [],
        approvals: [],
        outbox: [],
        notifications: [],
        media: [],
        billingAccounts: [],
        billingTransactions: [],
        providerState: [],
        backgroundJobs: [],
        extensions: {},
      },
      faults: [],
    },
    { namespace },
  );
  const platform = new SyntheticNativePlatform(world, [
    {
      id: surfaceId,
      initialState: { disposed: false, imports: 0 },
      handlers: {
        evaluate: (input) => ({
          value: {
            kind: "string",
            value: `${kind}:${(input as { code: string }).code}`,
          },
        }),
        importModule: (input, context) => {
          const state = context.state as { disposed: boolean; imports: number };
          context.setState({ ...state, imports: state.imports + 1 });
          return {
            exports: {
              kind: "object",
              entries: [
                [
                  "path",
                  {
                    kind: "string",
                    value: (input as { absolutePath: string }).absolutePath,
                  },
                ],
              ],
            },
          };
        },
        dispose: (_input, context) => {
          const state = context.state as { disposed: boolean; imports: number };
          context.setState({ ...state, disposed: true });
          return null;
        },
      },
    },
  ]);
  active.push({ world, platform });
  const invoke = (method: string, input: unknown) =>
    platform.invoke({ surfaceId, method, input: input as never });
  return {
    world,
    platform,
    plugin: {
      evaluate: (options: unknown) => invoke("evaluate", options),
      importModule: (options: unknown) => invoke("importModule", options),
      dispose: () => invoke("dispose", null),
    },
  };
}

afterEach(() => {
  for (const item of active.splice(0)) {
    item.platform.teardown();
    item.world.teardown();
  }
});

describe("native JavaScript runtime synthetic host", () => {
  it("executes the production JSC bridge with ledger and reset proof", async () => {
    const surface = "@elizaos/app-core:native-bridge:capacitorjsc";
    const { world, platform, plugin } = boot("native:jsc", surface, "jsc");
    const bridge = createCapacitorJscBridge(
      plugin as unknown as CapacitorJscPlugin,
    );
    await expect(bridge.evaluate({ code: "6 * 7" })).resolves.toEqual({
      kind: "string",
      value: "jsc:6 * 7",
    });
    await bridge.importModule({ absolutePath: "/synthetic/module.mjs" });
    await bridge.dispose();
    expect(world.ledger.byKind("readback")).toHaveLength(3);
    expect(platform.readback().surfaces[surface]).toEqual({
      disposed: true,
      imports: 1,
    });
    expect(platform.reset().surfaces[surface]).toEqual({
      disposed: false,
      imports: 0,
    });
    expect(world.ledger.all()).toEqual([]);
  });

  it("executes both production QuickJS kinds and fails on unavailable host", async () => {
    const surface = "@elizaos/app-core:native-bridge:capacitorquickjs";
    const { platform, plugin } = boot("native:quickjs", surface, "quickjs");
    const android = createCapacitorQuickJsBridge(
      plugin as unknown as CapacitorQuickJsPlugin,
      "quickjs-android",
    );
    const ios = createCapacitorQuickJsBridge(
      plugin as unknown as CapacitorQuickJsPlugin,
      "quickjs-ios-fallback",
    );
    expect(android.kind).toBe("quickjs-android");
    expect(ios.kind).toBe("quickjs-ios-fallback");
    await expect(android.evaluate({ code: "1 + 1" })).resolves.toEqual({
      kind: "string",
      value: "quickjs:1 + 1",
    });
    platform.setAvailable(surface, false);
    await expect(ios.evaluate({ code: "2 + 2" })).rejects.toMatchObject({
      code: "platform-unavailable",
    });
  });
});
