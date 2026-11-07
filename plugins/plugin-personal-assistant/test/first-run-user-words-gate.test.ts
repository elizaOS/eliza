/**
 * First-run gate reads the user's words, not the document envelope.
 *
 * Regression test for the `explicitlyRequestsFirstRun` fix: the gate used
 * to test the raw message text, so a first-run phrase inside recalled
 * document prose (wrapped by document augmentation) surfaced the
 * first-run affordance even when the user asked for something else.
 * The gate now tests `getUserMessageText(message)`, which unwraps the
 * document-augmentation envelope and prefers the connector's
 * `currentMessageText`.
 */

import { ChannelType, type IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";
import { resetAgentBackupStubState } from "./stubs/agent.ts";

function firstRunMessage(runtime: IAgentRuntime, text: string) {
  return {
    id: "msg" as never,
    entityId: runtime.agentId,
    roomId: runtime.agentId,
    agentId: runtime.agentId,
    content: { text, channelType: ChannelType.GROUP },
    createdAt: Date.now(),
  } as never;
}

/** Wraps a user request the way document augmentation does (see core `getUserMessageText`). */
function enveloped(documentProse: string, userRequest: string): string {
  return (
    "Answer the user request using the contextual documents below.\n" +
    `<contextual_documents>${documentProse}</contextual_documents>\n` +
    `<user_request>${userRequest}</user_request>`
  );
}

describe("first-run gate reads user words, not the document envelope", () => {
  beforeEach(() => {
    resetAgentBackupStubState();
  });

  it("stays quiet when only the recalled document mentions a first-run phrase", async () => {
    const runtime = createMinimalRuntimeStub();
    const { firstRunProvider } = await import("../src/providers/first-run.ts");
    const surface = await firstRunProvider.get(
      runtime,
      firstRunMessage(
        runtime,
        enveloped(
          "Onboarding checklist: initial setup — use defaults for a fresh install.",
          "summarize this",
        ),
      ),
      { values: {}, data: {}, text: "" } as never,
    );

    expect(surface.values?.firstRunPending).toBe(false);
    expect(surface.text).toBe("");
  });

  it("surfaces when the user's own enveloped request asks for onboarding", async () => {
    const runtime = createMinimalRuntimeStub();
    const { firstRunProvider } = await import("../src/providers/first-run.ts");
    const surface = await firstRunProvider.get(
      runtime,
      firstRunMessage(
        runtime,
        enveloped(
          "Onboarding checklist: initial setup — use defaults for a fresh install.",
          "run onboarding",
        ),
      ),
      { values: {}, data: {}, text: "" } as never,
    );

    expect(surface.values?.firstRunPending).toBe(true);
    expect(surface.text).toMatch(/setup pending/i);
  });

  it("still surfaces for a plain user first-run request", async () => {
    const runtime = createMinimalRuntimeStub();
    const { firstRunProvider } = await import("../src/providers/first-run.ts");
    const surface = await firstRunProvider.get(
      runtime,
      firstRunMessage(runtime, "use defaults"),
      { values: {}, data: {}, text: "" } as never,
    );

    expect(surface.values?.firstRunPending).toBe(true);
    expect(surface.text).toMatch(/setup pending/i);
  });
});
