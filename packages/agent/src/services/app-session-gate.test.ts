/**
 * app-session-gate unit test — the hosted-app session gate now reads AppManager
 * runs from a runtime-registered service (`APP_SESSION_SERVICE_TYPE`) instead of
 * statically importing `readAppRunStore` from `@elizaos/plugin-app-manager`.
 *
 * These tests prove the new seam: the gate queries `runtime.getService`, gates
 * off (fails open to "no active runs") when the service is absent, and matches
 * the previous behavior — active/non-stopped run for the canonical name → open;
 * stopped or foreign runs → closed — when the service is present.
 */

import type { Action, IAgentRuntime, Provider } from "@elizaos/core";
import {
  APP_SESSION_SERVICE_TYPE,
  type AppRunSummary,
  type AppSessionServiceLike,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  gatePluginSessionForHostedApp,
  hasActiveAppRunForCanonicalName,
  isHostedAppActiveForAgentActions,
} from "./app-session-gate.ts";

const APP = "@elizaos/plugin-wifi";

function run(appName: string, status: string): AppRunSummary {
  return { appName, status } as AppRunSummary;
}

/** Runtime whose getService returns the supplied service (or undefined). */
function makeRuntime(service?: AppSessionServiceLike): {
  runtime: IAgentRuntime;
  getService: ReturnType<typeof vi.fn>;
} {
  const getService = vi.fn((type: string) =>
    type === APP_SESSION_SERVICE_TYPE ? service : undefined,
  );
  return { runtime: { getService } as unknown as IAgentRuntime, getService };
}

function serviceWith(runs: AppRunSummary[]): AppSessionServiceLike {
  return { getRuns: () => runs };
}

describe("app-session-gate service seam", () => {
  it("queries the runtime for APP_SESSION_SERVICE_TYPE", () => {
    const { runtime, getService } = makeRuntime(serviceWith([]));
    hasActiveAppRunForCanonicalName(runtime, APP);
    expect(getService).toHaveBeenCalledWith(APP_SESSION_SERVICE_TYPE);
  });

  it("fails open to no-active-runs when the service is absent", () => {
    const { runtime } = makeRuntime(undefined);
    expect(hasActiveAppRunForCanonicalName(runtime, APP)).toBe(false);
    expect(isHostedAppActiveForAgentActions(runtime, APP)).toBe(false);
  });

  it("reports active for a non-stopped run matching the canonical name", () => {
    const { runtime } = makeRuntime(serviceWith([run(APP, "running")]));
    expect(hasActiveAppRunForCanonicalName(runtime, APP)).toBe(true);
  });

  it("ignores stopped runs and runs for other apps", () => {
    const stopped = makeRuntime(serviceWith([run(APP, "stopped")]));
    expect(hasActiveAppRunForCanonicalName(stopped.runtime, APP)).toBe(false);

    const foreign = makeRuntime(
      serviceWith([run("@elizaos/plugin-phone", "running")]),
    );
    expect(hasActiveAppRunForCanonicalName(foreign.runtime, APP)).toBe(false);
  });
});

describe("gatePluginSessionForHostedApp", () => {
  const baseAction: Action = {
    name: "APP_ACTION",
    description: "",
    examples: [],
    similes: [],
    validate: async () => true,
    handler: async () => undefined,
  };
  const baseProvider: Provider = {
    name: "APP_PROVIDER",
    get: async () => ({ text: "ok", data: { available: true } }),
  };

  it("blocks action validate + provider get when no session is active", async () => {
    const plugin = gatePluginSessionForHostedApp(
      {
        name: "p",
        description: "",
        actions: [baseAction],
        providers: [baseProvider],
      },
      APP,
    );
    const { runtime } = makeRuntime(undefined);
    const msg = {} as never;
    const state = {} as never;

    await expect(
      plugin.actions?.[0]?.validate?.(runtime, msg, state),
    ).resolves.toBe(false);
    const result = await plugin.providers?.[0]?.get(runtime, msg, state);
    expect(result?.data).toMatchObject({ appSessionInactive: true });
  });

  it("passes through to the wrapped action/provider when a run is active", async () => {
    const plugin = gatePluginSessionForHostedApp(
      {
        name: "p",
        description: "",
        actions: [baseAction],
        providers: [baseProvider],
      },
      APP,
    );
    const { runtime } = makeRuntime(serviceWith([run(APP, "running")]));
    const msg = {} as never;
    const state = {} as never;

    await expect(
      plugin.actions?.[0]?.validate?.(runtime, msg, state),
    ).resolves.toBe(true);
    const result = await plugin.providers?.[0]?.get(runtime, msg, state);
    expect(result?.text).toBe("ok");
  });
});
