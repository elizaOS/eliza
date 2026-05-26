// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFirstRunVoiceTranscript,
  buildFirstRunSubmitPlan,
  clearPersistedFirstRunState,
  type FirstRunProfileDraft,
  firstRunRuntimeTarget,
  isFirstRunPromptEcho,
  loadPersistedFirstRunState,
  nextFirstRunStep,
  normalizeFirstRunName,
  previousFirstRunStep,
  savePersistedFirstRunState,
  validateFirstRunSubmitDraft,
} from "./first-run";

const fallbackDraft: FirstRunProfileDraft = {
  ownerName: "Fallback Owner",
  agentName: "Fallback Agent",
  runtime: "local",
  remoteApiBase: "",
  remoteToken: "",
  useLocalEmbeddings: false,
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("first-run flow", () => {
  it("normalizes names without preserving accidental whitespace", () => {
    expect(normalizeFirstRunName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
  });

  it("moves through the deterministic first-run steps", () => {
    expect(nextFirstRunStep("owner")).toBe("agent");
    expect(nextFirstRunStep("agent")).toBe("runtime");
    expect(previousFirstRunStep("runtime")).toBe("agent");
    expect(previousFirstRunStep("owner")).toBeNull();
  });

  it("maps runtime choices to canonical first-run targets", () => {
    expect(firstRunRuntimeTarget("local")).toBe("local");
    expect(firstRunRuntimeTarget("cloud")).toBe("elizacloud");
    expect(firstRunRuntimeTarget("remote")).toBe("remote");
  });

  it("round-trips first-run progress until setup completes", () => {
    const draft: FirstRunProfileDraft = {
      ownerName: "Ada",
      agentName: "Milady",
      runtime: "remote",
      remoteApiBase: "https://agent.example.com",
      remoteToken: "token",
      useLocalEmbeddings: true,
    };

    savePersistedFirstRunState({ step: "remote", draft });
    expect(loadPersistedFirstRunState(fallbackDraft)).toEqual({
      step: "remote",
      draft,
    });

    clearPersistedFirstRunState();
    expect(loadPersistedFirstRunState(fallbackDraft)).toBeNull();
  });

  it("builds a server-backed local first-run payload", () => {
    const plan = buildFirstRunSubmitPlan({
      uiLanguage: "en",
      draft: {
        ownerName: "Ada",
        agentName: "Milady",
        runtime: "local",
        remoteApiBase: "",
        remoteToken: "",
        useLocalEmbeddings: false,
      },
    });

    expect(plan.payload).toMatchObject({
      name: "Milady",
      ownerName: "Ada",
      sandboxMode: "off",
      deploymentTarget: { runtime: "local" },
      features: {
        crypto: { enabled: true },
        browser: { enabled: true },
        voice: { enabled: true, firstRun: true },
      },
    });
    expect(plan.runtimeConfig.needsProviderSetup).toBe(true);
  });

  it("rejects first-run submission until the required spoken names exist", () => {
    expect(
      validateFirstRunSubmitDraft({
        ...fallbackDraft,
        ownerName: "",
        agentName: "Milady",
      }),
    ).toMatchObject({
      valid: false,
      step: "owner",
    });

    expect(
      validateFirstRunSubmitDraft({
        ...fallbackDraft,
        ownerName: "Ada",
        agentName: "",
      }),
    ).toMatchObject({
      valid: false,
      step: "agent",
    });

    expect(
      validateFirstRunSubmitDraft({
        ...fallbackDraft,
        ownerName: "Ada",
        agentName: "Milady",
        runtime: "remote",
        remoteApiBase: "",
      }),
    ).toMatchObject({
      valid: false,
      step: "remote",
    });
  });

  it("does not silently submit an anonymous first-run profile", () => {
    expect(() =>
      buildFirstRunSubmitPlan({
        uiLanguage: "en",
        draft: {
          ownerName: "",
          agentName: "Milady",
          runtime: "local",
          remoteApiBase: "",
          remoteToken: "",
          useLocalEmbeddings: false,
        },
      }),
    ).toThrow("First-run profile requires an owner name.");
  });

  it("keeps remote runtime addresses in the persisted config", () => {
    const plan = buildFirstRunSubmitPlan({
      uiLanguage: "en",
      draft: {
        ownerName: "Ada",
        agentName: "Remote Agent",
        runtime: "remote",
        remoteApiBase: "https://agent.example.com",
        remoteToken: "token",
        useLocalEmbeddings: false,
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

  it("applies voice transcripts as the canonical first-run input path", () => {
    const owner = applyFirstRunVoiceTranscript({
      step: "owner",
      draft: fallbackDraft,
      transcript: "my name is Ada Lovelace",
    });
    expect(owner).toMatchObject({
      step: "agent",
      draft: { ownerName: "Ada Lovelace" },
      action: "none",
    });

    const agent = applyFirstRunVoiceTranscript({
      step: "agent",
      draft: owner.draft,
      transcript: "keep Milady",
    });
    expect(agent).toMatchObject({
      step: "runtime",
      draft: { agentName: "Milady" },
      action: "none",
    });

    const runtime = applyFirstRunVoiceTranscript({
      step: "runtime",
      draft: agent.draft,
      transcript: "start local",
    });
    expect(runtime).toMatchObject({
      step: "runtime",
      draft: { runtime: "local" },
      action: "finish",
    });
  });

  it("filters prompt echo before voice transcripts can mutate setup state", () => {
    expect(
      isFirstRunPromptEcho({
        promptText: "What should Milady call you?",
        transcript: "what should milady call you",
      }),
    ).toBe(true);
    expect(
      isFirstRunPromptEcho({
        promptText: "What should Milady call you?",
        transcript: "my name is Ada",
      }),
    ).toBe(false);
  });

  it("routes spoken remote setup without leaving the first-run contract", () => {
    const runtime = applyFirstRunVoiceTranscript({
      step: "runtime",
      draft: fallbackDraft,
      transcript: "use a remote server",
    });
    expect(runtime).toMatchObject({
      step: "remote",
      draft: { runtime: "remote" },
      action: "none",
    });

    const remote = applyFirstRunVoiceTranscript({
      step: "remote",
      draft: runtime.draft,
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
