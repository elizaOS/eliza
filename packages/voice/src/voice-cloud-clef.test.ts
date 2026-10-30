import { createClefDecisionsClient } from "@elizaos/cloud-sdk/clef-decisions";
import { describe, expect, it } from "vitest";
import {
  CLOUD_CLEF_BLOCK_REASONS,
  type CloudClefPlanAdmission,
  type CloudClefStageOptions,
  cloudClefStatus,
  createCloudClefEndpointStage,
} from "./voice-cloud-clef";
import {
  CLEF_ENDPOINT_UNAVAILABLE_REASONS,
  type ClefTurnClient,
  createEndpointChain,
} from "./voice-endpoint-chain";
import { voiceTimingEndpoint } from "./voice-turn-timing";

// The real Cloud SDK client over a mock fetch. Nothing here reaches Eliza Cloud; these are binding
// contracts, not Clef, network or latency evidence.
interface Sent {
  url: string;
  body: Record<string, unknown>;
}
function mockCloud(
  answer: (body: Record<string, unknown>) => {
    status: number;
    body: unknown;
  } = () => ({
    status: 200,
    body: {
      status: "ok",
      kind: "turn",
      model: "clef-flash",
      complete: true,
      completeProbability: 0.92,
    },
  }),
) {
  const sent: Sent[] = [];
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ url: String(input), body });
    const reply = answer(body);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  const client = createClefDecisionsClient({
    baseUrl: "https://cloud.invalid",
    headers: async () => ({ authorization: "Bearer test-only" }),
    fetch,
  }) as ClefTurnClient;
  return { sent, client };
}

function ports(overrides: Partial<CloudClefStageOptions> = {}) {
  const state = {
    online: true,
    credential: true,
    plan: "admit" as CloudClefPlanAdmission | null,
  };
  const options: CloudClefStageOptions = {
    enabled: true,
    client: null,
    isOnline: () => state.online,
    hasCredential: () => state.credential,
    entitlement: () => state.plan,
    ...overrides,
  };
  return { state, options };
}
const signal = () => new AbortController().signal;

describe("createCloudClefEndpointStage", () => {
  it("is left out of the chain without the switch or a client", () => {
    const { client } = mockCloud();
    const off = createCloudClefEndpointStage(
      ports({ enabled: false, client }).options,
    );
    expect(off).toEqual({ enabled: false, client: null });
    expect(createEndpointChain({ clef: off })).toBeUndefined();
    const noClient = createCloudClefEndpointStage(ports().options);
    expect(noClient).toEqual({ enabled: false, client: null });
    expect(createEndpointChain({ clef: noClient })).toBeUndefined();
  });

  it("asks Cloud with the transcript text when online, signed in and on a plan", async () => {
    const { sent, client } = mockCloud();
    const { options } = ports({
      client,
      recentTurns: () => [{ speaker: "assistant", text: "Which city?" }],
    });
    const chain = createEndpointChain({
      clef: createCloudClefEndpointStage(options),
    });
    expect(await chain?.("Lisbon please", signal())).toMatchObject({
      decision: "finished",
      path: "clef",
    });
    expect(sent).toEqual([
      {
        url: "https://cloud.invalid/api/v1/decisions",
        body: {
          kind: "turn",
          transcript: "Lisbon please",
          recentTurns: [{ speaker: "assistant", text: "Which city?" }],
        },
      },
    ]);
  });

  it("falls back to the local scorer, then the long gap, when offline, signed out or without a plan", async () => {
    const { sent, client } = mockCloud();
    const { state, options } = ports({ client });
    let localAnswer: "finished" | "unavailable" = "unavailable";
    const localAsked: string[] = [];
    const chain = createEndpointChain({
      local: async (text) => {
        localAsked.push(text);
        return localAnswer === "finished"
          ? { decision: "finished", latencyMs: 5 }
          : { decision: "unavailable", reason: "unscored" };
      },
      clef: createCloudClefEndpointStage(options),
    });
    const cases: [() => void, string][] = [
      [() => (state.online = false), "clef-unavailable"],
      [() => (state.credential = false), "clef-disabled"],
      [() => (state.plan = "needs-plan"), "clef-disabled"],
      [() => (state.plan = null), "clef-disabled"],
    ];
    for (const [apply, reason] of cases) {
      state.online = true;
      state.credential = true;
      state.plan = "admit";
      apply();
      // The local scorer still decides when it can.
      localAnswer = "finished";
      expect(await chain?.("I am done", signal())).toEqual({
        decision: "finished",
        latencyMs: 5,
        path: "local",
      });
      // When it cannot, the blocked Clef stage answers unavailable and the session's gap submits.
      localAnswer = "unavailable";
      const result = await chain?.("I am done", signal());
      expect(result).toEqual({ decision: "unavailable", reason, path: "clef" });
      // The timing record keeps the path and the reason, so diagnostics name the fallback.
      expect(
        voiceTimingEndpoint({
          by: "gap",
          semantic: "unavailable",
          reason: result?.reason,
          path: "clef",
        }),
      ).toEqual({ by: "gap", semantic: "unavailable", reason, path: "clef" });
    }
    expect(localAsked).toHaveLength(cases.length * 2);
    expect(sent).toEqual([]);

    // The same chain asks Cloud again once the state recovers, without being rebuilt.
    state.online = true;
    state.credential = true;
    state.plan = "admit-with-warning";
    expect(await chain?.("I am done", signal())).toMatchObject({
      decision: "finished",
      path: "clef",
    });
    expect(sent).toHaveLength(1);
  });

  it("admits an unknown plan state and lets Cloud refuse it, never as a yes", async () => {
    const { sent, client } = mockCloud(() => ({
      status: 503,
      body: { status: "unavailable", reason: "no_plan" },
    }));
    const { options } = ports({ client, entitlement: () => "unknown" });
    const chain = createEndpointChain({
      clef: createCloudClefEndpointStage(options),
    });
    expect(await chain?.("I am done", signal())).toEqual({
      decision: "unavailable",
      reason: "clef-unavailable",
      path: "clef",
    });
    expect(sent).toHaveLength(1);
  });

  it("treats a missing or throwing port as blocked", async () => {
    const { sent, client } = mockCloud();
    const throwing = () => {
      throw new Error("port failed");
    };
    for (const [override, block] of [
      [{ isOnline: throwing }, "offline"],
      [{ hasCredential: throwing }, "no-credential"],
      [{ entitlement: throwing }, "no-plan"],
      [{ isOnline: undefined }, "offline"],
      [{ isOnline: () => "yes" }, "offline"],
      [{ entitlement: () => "active" }, "no-plan"],
    ] as [Partial<CloudClefStageOptions>, string][]) {
      const { options } = ports({ client, ...override });
      expect(cloudClefStatus(options)).toMatchObject({ ready: false, block });
      const chain = createEndpointChain({
        clef: createCloudClefEndpointStage(options),
      });
      expect(await chain?.("I am done", signal())).toMatchObject({
        decision: "unavailable",
        path: "clef",
      });
    }
    expect(sent).toEqual([]);
  });

  it("stops between stages when speech resumes, and never asks Cloud", async () => {
    const { sent, client } = mockCloud();
    const controller = new AbortController();
    const chain = createEndpointChain({
      local: async () => {
        controller.abort(new DOMException("speech resumed", "AbortError"));
        return { decision: "unavailable", reason: "unscored" };
      },
      clef: createCloudClefEndpointStage(ports({ client }).options),
    });
    await expect(chain?.("I am done", controller.signal)).rejects.toThrow(
      "speech resumed",
    );
    expect(sent).toEqual([]);
  });

  it("aborts an in-flight Cloud request when speech resumes", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = ((_input: URL | string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) =>
        requestSignal?.addEventListener(
          "abort",
          () => reject(requestSignal?.reason),
          { once: true },
        ),
      );
    }) as typeof globalThis.fetch;
    const client = createClefDecisionsClient({
      baseUrl: "https://cloud.invalid",
      headers: async () => ({}),
      fetch,
    }) as ClefTurnClient;
    const controller = new AbortController();
    const chain = createEndpointChain({
      clef: createCloudClefEndpointStage(ports({ client }).options),
    });
    const pending = chain?.("I am done", controller.signal);
    for (let i = 0; i < 5 && !requestSignal; i++) await Promise.resolve();
    controller.abort(new DOMException("speech resumed", "AbortError"));
    await expect(pending).rejects.toThrow("speech resumed");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("sends only speaker and text in recent turns, never audio, and at most 6", async () => {
    const { sent, client } = mockCloud();
    const audio = new Uint8Array([1, 2, 3]);
    const turns = Array.from({ length: 9 }, (_, index) => ({
      speaker: index % 2 ? "assistant" : "person",
      text: `turn ${index}`,
      audio,
      pcm: new Float32Array(4),
      audioUrl: "blob:local-recording",
    })) as unknown as { speaker: "person" | "assistant"; text: string }[];
    const chain = createEndpointChain({
      clef: createCloudClefEndpointStage(
        ports({ client, recentTurns: () => turns }).options,
      ),
    });
    await chain?.("and that is all", signal());
    expect(sent).toHaveLength(1);
    const body = sent[0]?.body as {
      transcript: string;
      recentTurns: Record<string, unknown>[];
    };
    expect(Object.keys(body).sort()).toEqual([
      "kind",
      "recentTurns",
      "transcript",
    ]);
    expect(typeof body.transcript).toBe("string");
    expect(body.recentTurns).toHaveLength(6);
    expect(body.recentTurns.map((turn) => turn.text)).toEqual([
      "turn 3",
      "turn 4",
      "turn 5",
      "turn 6",
      "turn 7",
      "turn 8",
    ]);
    for (const turn of body.recentTurns)
      expect(Object.keys(turn).sort()).toEqual(["speaker", "text"]);
    expect(JSON.stringify(body)).not.toMatch(/audio|pcm|blob:/);
  });
});

describe("cloudClefStatus", () => {
  it("names each block in a fixed order and maps it onto the chain's reasons", () => {
    const { client } = mockCloud();
    expect(cloudClefStatus(null)).toMatchObject({ block: "disabled" });
    expect(cloudClefStatus(ports().options)).toMatchObject({
      block: "no-client",
    });
    expect(
      cloudClefStatus(
        ports({
          client,
          isOnline: () => false,
          hasCredential: () => false,
          entitlement: () => "needs-plan",
        }).options,
      ),
    ).toEqual({ ready: false, block: "offline", reason: "clef-unavailable" });
    expect(cloudClefStatus(ports({ client }).options)).toEqual({ ready: true });
    for (const reason of Object.values(CLOUD_CLEF_BLOCK_REASONS))
      expect(CLEF_ENDPOINT_UNAVAILABLE_REASONS).toContain(reason);
  });
});
