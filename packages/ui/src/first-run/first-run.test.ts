// @vitest-environment jsdom

// Deterministic first-run helpers: draft normalization, runtime-target
// mapping, submit validation, and the /api/first-run payload builder.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFirstRunSubmitPlan,
  clearPersistedFirstRunState,
  DEFAULT_AGENT_NAME,
  type FirstRunProfileDraft,
  firstRunDownloadsLocalModel,
  firstRunNeedsCloudConnect,
  firstRunRuntimeTarget,
  normalizeFirstRunName,
  validateFirstRunSubmitDraft,
} from "./first-run";

const fallbackDraft: FirstRunProfileDraft = {
  agentName: "Fallback Agent",
  runtime: "local",
  localInference: "all-local",
  remoteApiBase: "",
  remoteToken: "",
};

function ensureLocalStorage(): Storage {
  if (typeof window.localStorage?.clear === "function") {
    return window.localStorage;
  }
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  } satisfies Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

beforeEach(() => {
  ensureLocalStorage().clear();
});

afterEach(() => {
  ensureLocalStorage().clear();
});

describe("first-run flow", () => {
  it("normalizes names without preserving accidental whitespace", () => {
    expect(normalizeFirstRunName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
  });

  it("defaults the agent name to the first style preset", () => {
    expect(DEFAULT_AGENT_NAME).toBe("Eliza");
  });

  it("maps runtime choices to canonical first-run targets", () => {
    expect(firstRunRuntimeTarget("local")).toBe("local");
    expect(firstRunRuntimeTarget("local", "all-local")).toBe("local");
    expect(firstRunRuntimeTarget("local", "cloud-inference")).toBe(
      "elizacloud-hybrid",
    );
    expect(firstRunRuntimeTarget("cloud")).toBe("elizacloud");
    expect(firstRunRuntimeTarget("remote")).toBe("remote");
  });

  it("requires a cloud connection for cloud and local+cloud-inference only", () => {
    const connect = (
      draft: Pick<FirstRunProfileDraft, "runtime" | "localInference">,
      connected: boolean,
    ) => firstRunNeedsCloudConnect(draft, connected);

    expect(
      connect({ runtime: "cloud", localInference: "all-local" }, false),
    ).toBe(true);
    expect(
      connect({ runtime: "cloud", localInference: "all-local" }, true),
    ).toBe(false);
    expect(
      connect({ runtime: "local", localInference: "cloud-inference" }, false),
    ).toBe(true);
    expect(
      connect({ runtime: "local", localInference: "cloud-inference" }, true),
    ).toBe(false);
    expect(
      connect({ runtime: "local", localInference: "all-local" }, false),
    ).toBe(false);
    expect(
      connect({ runtime: "remote", localInference: "all-local" }, false),
    ).toBe(false);
  });

  it("only downloads an on-device model for all-local inference", () => {
    expect(firstRunDownloadsLocalModel("all-local")).toBe(true);
    expect(firstRunDownloadsLocalModel("cloud-inference")).toBe(false);
  });

  it("clears the legacy wizard draft left behind by old installs", () => {
    window.localStorage.setItem(
      "eliza:first-run",
      JSON.stringify({ step: "remote", draft: fallbackDraft }),
    );
    clearPersistedFirstRunState();
    expect(window.localStorage.getItem("eliza:first-run")).toBeNull();
  });

  it("builds a server-backed local first-run payload without an owner name", () => {
    const plan = buildFirstRunSubmitPlan({
      uiLanguage: "en",
      draft: {
        agentName: "Eliza",
        runtime: "local",
        localInference: "all-local",
        remoteApiBase: "",
        remoteToken: "",
      },
    });

    expect(plan.payload).toMatchObject({
      name: "Eliza",
      sandboxMode: "off",
      deploymentTarget: { runtime: "local" },
      features: {
        crypto: { enabled: true },
        browser: { enabled: true },
        voice: { enabled: true, firstRun: true },
      },
    });
    expect(plan.payload).not.toHaveProperty("ownerName");
    // On-device inference intentionally omits the runtime provider (the local
    // model downloads in the background and the local-inference handler serves
    // it), so the user must NOT be nagged to "choose a model provider in
    // Settings" right after picking On-device.
    expect(plan.runtimeConfig.needsProviderSetup).toBe(false);
  });

  it('routes "Other / configure in Settings" (configure-later) to the provider-setup handoff without downloading a local model (#9952 / C1)', () => {
    const plan = buildFirstRunSubmitPlan({
      uiLanguage: "en",
      draft: {
        agentName: "Eliza",
        runtime: "local",
        localInference: "configure-later",
        remoteApiBase: "",
        remoteToken: "",
      },
    });

    // Local backend, no provider wired in the payload (the user picks one in
    // Settings) — distinct from on-device, which downloads a model.
    expect(plan.payload).toMatchObject({
      deploymentTarget: { runtime: "local" },
    });
    expect(plan.payload.deploymentTarget).not.toHaveProperty("provider");
    // The fix: unlike all-local, configure-later leaves needsProviderSetup TRUE,
    // so the finish path opens the "Open Settings" banner (the #9952 handoff the
    // "Other" choice promises). Was silently false before the C1 fix.
    expect(plan.runtimeConfig.needsProviderSetup).toBe(true);
    // And it must NOT kick off an on-device model download.
    expect(firstRunDownloadsLocalModel("configure-later")).toBe(false);
  });

  it("does not nag for a provider on remote-connect (the remote agent owns it)", () => {
    const plan = buildFirstRunSubmitPlan({
      uiLanguage: "en",
      draft: {
        agentName: "Eliza",
        runtime: "remote",
        localInference: "all-local",
        remoteApiBase: "https://agent.example.com",
        remoteToken: "",
      },
    });
    expect(plan.runtimeConfig.needsProviderSetup).toBe(false);
  });

  it("routes local + cloud-inference to the hybrid target with a cloud provider", () => {
    const plan = buildFirstRunSubmitPlan({
      uiLanguage: "en",
      draft: {
        agentName: "Eliza",
        runtime: "local",
        localInference: "cloud-inference",
        remoteApiBase: "",
        remoteToken: "",
      },
    });

    expect(plan.payload).toMatchObject({
      deploymentTarget: { runtime: "local", provider: "elizacloud" },
    });
  });

  it("falls back to the default agent name when none is provided", () => {
    const plan = buildFirstRunSubmitPlan({
      uiLanguage: "en",
      draft: {
        agentName: "",
        runtime: "local",
        localInference: "all-local",
        remoteApiBase: "",
        remoteToken: "",
      },
    });
    expect(plan.payload).toMatchObject({ name: DEFAULT_AGENT_NAME });
  });

  it("only blocks submission when a remote runtime is missing its URL", () => {
    expect(
      validateFirstRunSubmitDraft({
        ...fallbackDraft,
        runtime: "remote",
        remoteApiBase: "",
      }),
    ).toMatchObject({ valid: false });

    expect(
      validateFirstRunSubmitDraft({ ...fallbackDraft, runtime: "local" }),
    ).toMatchObject({ valid: true });
  });

  it("rejects hostile remote runtime targets before submission", () => {
    for (const remoteApiBase of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "http://",
      "not a url",
    ]) {
      expect(
        validateFirstRunSubmitDraft({
          ...fallbackDraft,
          runtime: "remote",
          remoteApiBase,
        }),
      ).toMatchObject({ valid: false });
    }

    expect(
      validateFirstRunSubmitDraft({
        ...fallbackDraft,
        runtime: "remote",
        remoteApiBase: "https://agent.example.com",
      }),
    ).toMatchObject({ valid: true });
  });

  it("keeps remote runtime addresses in the persisted config", () => {
    const plan = buildFirstRunSubmitPlan({
      uiLanguage: "en",
      draft: {
        agentName: "Remote Agent",
        runtime: "remote",
        localInference: "all-local",
        remoteApiBase: "https://agent.example.com",
        remoteToken: "token",
      },
    });

    expect(plan.payload).toMatchObject({
      name: "Remote Agent",
      deploymentTarget: {
        runtime: "remote",
        provider: "remote",
        remoteApiBase: "https://agent.example.com",
        remoteAccessToken: "token",
      },
    });
  });
});
