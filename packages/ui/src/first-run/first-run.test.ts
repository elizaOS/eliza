// @vitest-environment jsdom

import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFirstRunVoiceTranscript,
  buildFirstRunSubmitPlan,
  clearPersistedFirstRunState,
  DEFAULT_AGENT_NAME,
  FIRST_RUN_STEPS,
  type FirstRunProfileDraft,
  firstRunDownloadsLocalModel,
  firstRunNeedsCloudConnect,
  firstRunRuntimeTarget,
  isFirstRunPromptEcho,
  loadPersistedFirstRunState,
  nextFirstRunStep,
  normalizeCloudOnlyFirstRunState,
  normalizeFirstRunName,
  previousFirstRunStep,
  savePersistedFirstRunState,
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

  it("moves through the runtime → remote steps without name capture", () => {
    expect(nextFirstRunStep("runtime")).toBe("remote");
    expect(nextFirstRunStep("remote")).toBeNull();
    expect(previousFirstRunStep("remote")).toBe("runtime");
    expect(previousFirstRunStep("runtime")).toBeNull();
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

  it("round-trips first-run progress until setup completes", () => {
    const draft: FirstRunProfileDraft = {
      agentName: "Eliza",
      runtime: "remote",
      localInference: "all-local",
      remoteApiBase: "https://agent.example.com",
      remoteToken: "token",
    };

    savePersistedFirstRunState({ step: "remote", draft });
    expect(loadPersistedFirstRunState(fallbackDraft)).toEqual({
      step: "remote",
      draft,
    });

    clearPersistedFirstRunState();
    expect(loadPersistedFirstRunState(fallbackDraft)).toBeNull();
  });

  it("fuzzes corrupted persisted first-run state into a safe normalized draft", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        window.localStorage.setItem("eliza:first-run", JSON.stringify(value));
        const loaded = loadPersistedFirstRunState(fallbackDraft);
        if (loaded === null) return;

        expect(FIRST_RUN_STEPS).toContain(loaded.step);
        expect(["local", "cloud", "remote"]).toContain(loaded.draft.runtime);
        expect(["all-local", "cloud-inference"]).toContain(
          loaded.draft.localInference,
        );
        expect(typeof loaded.draft.agentName).toBe("string");
        expect(typeof loaded.draft.remoteApiBase).toBe("string");
        expect(typeof loaded.draft.remoteToken).toBe("string");
      }),
      { numRuns: 300 },
    );
  });

  it("normalizes persisted cloud-only first-run state back to cloud runtime", () => {
    const state = normalizeCloudOnlyFirstRunState({
      step: "remote",
      draft: {
        agentName: "Eliza",
        runtime: "remote",
        localInference: "all-local",
        remoteApiBase: "https://agent.example.com",
        remoteToken: "secret",
      },
    });

    expect(state).toEqual({
      step: "runtime",
      draft: {
        agentName: "Eliza",
        runtime: "cloud",
        localInference: "all-local",
        remoteApiBase: "",
        remoteToken: "",
      },
    });
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
    expect(plan.runtimeConfig.needsProviderSetup).toBe(true);
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
    ).toMatchObject({ valid: false, step: "remote" });

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
      ).toMatchObject({ valid: false, step: "remote" });
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

  it("applies voice transcripts to select and launch a runtime", () => {
    const remote = applyFirstRunVoiceTranscript({
      step: "runtime",
      draft: fallbackDraft,
      transcript: "use a remote server",
    });
    expect(remote).toMatchObject({
      step: "remote",
      draft: { runtime: "remote" },
      action: "none",
    });

    const local = applyFirstRunVoiceTranscript({
      step: "runtime",
      draft: fallbackDraft,
      transcript: "start local",
    });
    expect(local).toMatchObject({
      step: "runtime",
      draft: { runtime: "local" },
      action: "finish",
    });
  });

  it("filters prompt echo before voice transcripts can mutate setup state", () => {
    expect(
      isFirstRunPromptEcho({
        promptText: "Where should Eliza run?",
        transcript: "where should eliza run",
      }),
    ).toBe(true);
    expect(
      isFirstRunPromptEcho({
        promptText: "Where should Eliza run?",
        transcript: "use a remote server",
      }),
    ).toBe(false);
  });

  it("routes spoken remote setup without leaving the first-run contract", () => {
    const remote = applyFirstRunVoiceTranscript({
      step: "remote",
      draft: { ...fallbackDraft, runtime: "remote" },
      transcript: "agent dot example dot com",
    });
    expect(remote).toMatchObject({
      step: "remote",
      draft: { remoteApiBase: "agent.example.com" },
      action: "none",
    });

    const finish = applyFirstRunVoiceTranscript({
      step: "remote",
      draft: remote.draft,
      transcript: "continue",
    });
    expect(finish.action).toBe("finish");
  });
});
