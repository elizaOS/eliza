/**
 * Unit coverage for the hot reload strategy. Drives the real apply() path:
 * env skip vs apply, provider-env failure rethrow, best-effort plugin notify,
 * intent description, default applyConfig iteration, and the default env-pump
 * rejection for an unknown provider.
 */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import type { SecretsManager } from "@elizaos/vault";
import { describe, expect, it } from "vitest";
import { createHotStrategy } from "./reload-hot.ts";
import type {
  OperationIntent,
  OperationPhase,
  ProviderSwitchIntent,
  ReloadContext,
} from "./types.ts";

function dummySecrets(): SecretsManager {
  return {
    vault: {
      reveal: async () => {
        throw new Error("dummy vault.reveal must not be called");
      },
    },
  } as unknown as SecretsManager;
}

function makeRuntime(plugins: Plugin[] = []): AgentRuntime {
  return { plugins } as AgentRuntime;
}

function makePlugin(partial: {
  name: string;
  applyConfig?: Plugin["applyConfig"] | string;
  config?: Record<string, string | number | boolean | null | undefined>;
}): Plugin {
  return {
    name: partial.name,
    description: partial.name,
    ...(partial.applyConfig ? { applyConfig: partial.applyConfig } : {}),
    ...(partial.config ? { config: partial.config } : {}),
  } as Plugin;
}

function makeCtx(
  intent: OperationIntent,
  plugins: Plugin[] = [],
): ReloadContext & { phases: OperationPhase[] } {
  const phases: OperationPhase[] = [];
  return {
    runtime: makeRuntime(plugins),
    intent,
    phases,
    reportPhase: async (phase: OperationPhase) => {
      phases.push(phase);
    },
  };
}

function phaseNames(phases: OperationPhase[]): string[] {
  return phases.map((phase) => `${phase.name}:${phase.status}`);
}

describe("createHotStrategy", () => {
  it("has the hot tier", () => {
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
    });
    expect(strategy.tier).toBe("hot");
  });

  it("applies env then notifies plugins for a provider-switch and returns the same runtime", async () => {
    const applied: ProviderSwitchIntent[] = [];
    const notifications: Array<{
      runtime: AgentRuntime;
      change: { kind: string; detail?: Record<string, unknown> };
    }> = [];
    const intent: ProviderSwitchIntent = {
      kind: "provider-switch",
      provider: "openai",
    };
    const ctx = makeCtx(intent);
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async (next) => {
        applied.push(next);
      },
      notifyConfigChanged: async (runtime, change) => {
        notifications.push({ runtime, change });
      },
    });

    const result = await strategy.apply(ctx);

    expect(result).toBe(ctx.runtime);
    expect(applied).toEqual([intent]);
    expect(notifications).toEqual([
      {
        runtime: ctx.runtime,
        change: { kind: "provider-switch", detail: { provider: "openai" } },
      },
    ]);
    expect(phaseNames(ctx.phases)).toEqual([
      "apply-env:succeeded",
      "notify-plugins:succeeded",
    ]);
    expect(ctx.phases[0]?.detail).toEqual({ provider: "openai" });
    expect(ctx.phases[1]?.detail).toEqual({ provider: "openai" });
    for (const phase of ctx.phases) {
      expect(typeof phase.startedAt).toBe("number");
      expect(typeof phase.finishedAt).toBe("number");
      expect(phase.finishedAt ?? 0).toBeGreaterThanOrEqual(
        phase.startedAt ?? 0,
      );
    }
  });

  it("is safe to apply twice with the same provider-switch intent", async () => {
    const applied: string[] = [];
    const ctx = makeCtx({ kind: "provider-switch", provider: "anthropic" });
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async (intent) => {
        applied.push(intent.provider);
      },
      notifyConfigChanged: async () => {},
    });

    expect(await strategy.apply(ctx)).toBe(ctx.runtime);
    expect(await strategy.apply(ctx)).toBe(ctx.runtime);
    expect(applied).toEqual(["anthropic", "anthropic"]);
    expect(phaseNames(ctx.phases)).toEqual([
      "apply-env:succeeded",
      "notify-plugins:succeeded",
      "apply-env:succeeded",
      "notify-plugins:succeeded",
    ]);
  });

  it("rethrows provider-env failure after reporting apply-env failed and does not notify plugins", async () => {
    let notified = 0;
    const ctx = makeCtx({ kind: "provider-switch", provider: "openai" });
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {
        throw new Error("env pump failed");
      },
      notifyConfigChanged: async () => {
        notified += 1;
      },
    });

    await expect(strategy.apply(ctx)).rejects.toThrow("env pump failed");
    expect(notified).toBe(0);
    expect(phaseNames(ctx.phases)).toEqual(["apply-env:failed"]);
    expect(ctx.phases[0]?.error?.message).toContain("env pump failed");
  });

  it("skips apply-env for every non-provider-switch intent", async () => {
    const intents: OperationIntent[] = [
      { kind: "config-reload" },
      { kind: "config-reload", changedPaths: ["env.OPENAI_API_KEY"] },
      { kind: "plugin-enable", pluginId: "plugin-sql" },
      { kind: "plugin-disable", pluginId: "plugin-sql" },
      { kind: "restart", reason: "manual" },
    ];
    let envCalls = 0;

    for (const intent of intents) {
      const ctx = makeCtx(intent);
      const strategy = createHotStrategy({
        secrets: dummySecrets(),
        applyProviderEnv: async () => {
          envCalls += 1;
        },
        notifyConfigChanged: async () => {},
      });
      await strategy.apply(ctx);
      expect(phaseNames(ctx.phases)).toEqual([
        "apply-env:skipped",
        "notify-plugins:succeeded",
      ]);
      expect(ctx.phases[0]?.detail).toEqual({
        reason: `intent=${intent.kind}`,
      });
    }

    expect(envCalls).toBe(0);
  });

  it("describes provider-switch optional fields only when they are present", async () => {
    const changes: Array<{ kind: string; detail?: Record<string, unknown> }> =
      [];
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
      notifyConfigChanged: async (_runtime, change) => {
        changes.push(change);
      },
    });

    await strategy.apply(
      makeCtx({
        kind: "provider-switch",
        provider: "openai",
        primaryModel: "gpt-4.1",
        apiKeyRef: "providers.openai.api-key",
      }),
    );
    await strategy.apply(
      makeCtx({
        kind: "provider-switch",
        provider: "openai",
        primaryModel: "",
        apiKeyRef: "",
      }),
    );

    expect(changes).toEqual([
      {
        kind: "provider-switch",
        detail: {
          provider: "openai",
          primaryModel: "gpt-4.1",
          apiKeyChanged: true,
        },
      },
      {
        kind: "provider-switch",
        detail: { provider: "openai" },
      },
    ]);
  });

  it("copies config-reload changedPaths into notify detail", async () => {
    const changedPaths = ["env.FOO", "models.large"];
    let notifiedDetail: Record<string, unknown> | undefined;
    const ctx = makeCtx({ kind: "config-reload", changedPaths });
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
      notifyConfigChanged: async (_runtime, change) => {
        notifiedDetail = change.detail;
      },
    });

    await strategy.apply(ctx);

    expect(notifiedDetail).toEqual({
      changedPaths: ["env.FOO", "models.large"],
    });
    expect(notifiedDetail?.changedPaths).not.toBe(changedPaths);
    expect(ctx.phases[1]?.detail).toEqual({
      changedPaths: ["env.FOO", "models.large"],
    });
  });

  it("describes config-reload without changedPaths as an empty detail object", async () => {
    let notifiedDetail: Record<string, unknown> | undefined;
    const ctx = makeCtx({ kind: "config-reload" });
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
      notifyConfigChanged: async (_runtime, change) => {
        notifiedDetail = change.detail;
      },
    });

    await strategy.apply(ctx);

    expect(notifiedDetail).toEqual({});
    expect(ctx.phases[1]?.detail).toEqual({});
  });

  it("describes plugin enable/disable and restart intents", async () => {
    const changes: Array<{ kind: string; detail?: Record<string, unknown> }> =
      [];
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
      notifyConfigChanged: async (_runtime, change) => {
        changes.push(change);
      },
    });

    await strategy.apply(makeCtx({ kind: "plugin-enable", pluginId: "p1" }));
    await strategy.apply(makeCtx({ kind: "plugin-disable", pluginId: "p2" }));
    await strategy.apply(makeCtx({ kind: "restart", reason: "owner asked" }));
    await strategy.apply(makeCtx({ kind: "restart", reason: "" }));

    expect(changes).toEqual([
      { kind: "plugin-enable", detail: { pluginId: "p1" } },
      { kind: "plugin-disable", detail: { pluginId: "p2" } },
      { kind: "restart", detail: { reason: "owner asked" } },
      { kind: "restart", detail: { reason: "" } },
    ]);
  });

  it("reports notify-plugins failed but still returns the runtime when notify throws", async () => {
    const ctx = makeCtx({ kind: "provider-switch", provider: "openai" });
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
      notifyConfigChanged: async () => {
        throw new Error("notify exploded");
      },
    });

    const result = await strategy.apply(ctx);

    expect(result).toBe(ctx.runtime);
    expect(phaseNames(ctx.phases)).toEqual([
      "apply-env:succeeded",
      "notify-plugins:failed",
    ]);
    expect(ctx.phases[1]?.error?.message).toContain("notify exploded");
  });
});

describe("createHotStrategy default notifyConfigChanged", () => {
  it("succeeds when the runtime has no plugins", async () => {
    const ctx = makeCtx({ kind: "config-reload" });
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
    });

    expect(await strategy.apply(ctx)).toBe(ctx.runtime);
    expect(phaseNames(ctx.phases)).toEqual([
      "apply-env:skipped",
      "notify-plugins:succeeded",
    ]);
  });

  it("skips plugins without an applyConfig function and notifies the rest", async () => {
    const received: Array<{
      name: string;
      config: Record<string, string>;
      runtime: object;
    }> = [];
    const plugins = [
      makePlugin({ name: "no-hook" }),
      makePlugin({
        name: "not-a-function",
        applyConfig: "nope",
      }),
      makePlugin({
        name: "wired",
        config: {
          enabled: true,
          retries: 2,
          label: "ok",
          gone: null,
          missing: undefined,
        },
        applyConfig: async (config, runtime) => {
          received.push({ name: "wired", config, runtime });
        },
      }),
    ];
    const ctx = makeCtx({ kind: "config-reload" }, plugins);
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
    });

    await strategy.apply(ctx);

    expect(received).toEqual([
      {
        name: "wired",
        config: { enabled: "true", retries: "2", label: "ok" },
        runtime: ctx.runtime,
      },
    ]);
    expect(phaseNames(ctx.phases)).toEqual([
      "apply-env:skipped",
      "notify-plugins:succeeded",
    ]);
  });

  it("keeps notify-plugins succeeded when a plugin applyConfig throws, and continues the queue", async () => {
    const called: string[] = [];
    const plugins = [
      makePlugin({
        name: "boom",
        applyConfig: async () => {
          called.push("boom");
          throw new Error("applyConfig boom");
        },
      }),
      makePlugin({
        name: "ok",
        applyConfig: async () => {
          called.push("ok");
        },
      }),
    ];
    const ctx = makeCtx({ kind: "plugin-enable", pluginId: "ok" }, plugins);
    const strategy = createHotStrategy({
      secrets: dummySecrets(),
      applyProviderEnv: async () => {},
    });

    const result = await strategy.apply(ctx);

    expect(result).toBe(ctx.runtime);
    expect(called).toEqual(["boom", "ok"]);
    expect(phaseNames(ctx.phases)).toEqual([
      "apply-env:skipped",
      "notify-plugins:succeeded",
    ]);
  });
});

describe("createHotStrategy default applyProviderEnv", () => {
  it("fails apply-env for an unknown provider without notifying plugins", async () => {
    const ctx = makeCtx({
      kind: "provider-switch",
      provider: "not-a-real-provider",
    });
    const strategy = createHotStrategy({ secrets: dummySecrets() });

    await expect(strategy.apply(ctx)).rejects.toThrow(
      '[runtime-ops] hot reload: invalid provider "not-a-real-provider"',
    );
    expect(phaseNames(ctx.phases)).toEqual(["apply-env:failed"]);
    expect(ctx.phases[0]?.error?.message).toContain(
      '[runtime-ops] hot reload: invalid provider "not-a-real-provider"',
    );
  });

  it("fails apply-env when the vault cannot resolve apiKeyRef", async () => {
    const secrets = {
      vault: {
        reveal: async () => {
          throw new Error("no such secret");
        },
      },
    } as unknown as SecretsManager;
    const ctx = makeCtx({
      kind: "provider-switch",
      provider: "openai",
      apiKeyRef: "providers.openai.api-key",
    });
    const strategy = createHotStrategy({ secrets });

    await expect(strategy.apply(ctx)).rejects.toThrow(
      "[runtime-ops:vault] failed to resolve providers.openai.api-key: no such secret",
    );
    expect(phaseNames(ctx.phases)).toEqual(["apply-env:failed"]);
    expect(ctx.phases[0]?.error?.message).toContain(
      "failed to resolve providers.openai.api-key",
    );
  });
});
