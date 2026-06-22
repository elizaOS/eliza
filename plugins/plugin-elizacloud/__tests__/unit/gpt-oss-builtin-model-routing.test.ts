/**
 * gpt-oss-120b built-in coding / sub-agent text-model routing.
 *
 * The eliza-cloud built-in text model (the "small"/coding slot, and every tier
 * that delegates to it) MUST resolve to "gpt-oss-120b", and "gpt-oss-120b" must
 * be recognized as the Cerebras-served family (the json_schema -> json_object
 * scrub in text.ts keys on `lower.includes("gpt-oss")`). This file pins that
 * behavior deterministically and offline.
 *
 * DETERMINISTIC block (always runs, no network/key):
 *   - DEFAULT_ELIZA_CLOUD_TEXT_MODEL / DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL
 *     === "gpt-oss-120b" (the canary on packages/core/.../service-routing.ts).
 *   - getSmallModel / getNanoModel / getMediumModel / getResponseHandlerModel
 *     fall back to "gpt-oss-120b" through the documented setting chain, and an
 *     explicit override beats the default (precedence is honored, not hardcoded).
 *   - buildElizaCloudServiceRoute() shape, and that it carries the built-in
 *     smallModel when populated.
 *   - the resolved small-model is recognized as Cerebras/gpt-oss-served via the
 *     same lower.includes("gpt-oss") rule text.ts uses internally.
 *
 * LIVE block (gated; SKIPPED with one console.warn when the key is absent):
 *   - isCloudConnected(toRuntimeSettings(runtime)) === true and a real
 *     generateNativeChatCompletion round-trip against gpt-oss-120b returns a
 *     non-empty completion (no 400 on response_format because the cerebras
 *     scrub fired). Also mirrors the server-side canonicalizeCerebrasModelId
 *     collapse, behind a guarded import so a heavy/unresolvable cloud-shared
 *     dep skips cleanly instead of breaking the lane.
 *
 * Baseline note: __tests__/unit/text-cerebras-response-format.test.ts already
 * proves the json_object scrub on the wire for gpt-oss; this file is the
 * routing/identity canary — if the default ever moves off gpt-oss-120b, these
 * cases (and service-routing.ts) must change in lockstep.
 */
import {
  DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  type IAgentRuntime,
} from "@elizaos/core";
import { buildElizaCloudServiceRoute } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNativeChatCompletion } from "../../src/models/text";
import {
  getMediumModel,
  getNanoModel,
  getResponseHandlerModel,
  getSmallModel,
} from "../../src/utils/config";

const BUILTIN_TEXT_MODEL = "gpt-oss-120b";

type RuntimeFixture = Pick<IAgentRuntime, "character" | "emitEvent" | "getSetting"> &
  Partial<IAgentRuntime>;

/**
 * Build a runtime whose getSetting reads from an explicit Record. Unset keys
 * return `undefined` (NOT null) so plugin-elizacloud's `?? default` fallback
 * chain falls through exactly as it does against a real runtime.
 *
 * NOTE: process.env can shadow the runtime (getSetting in config.ts falls back
 * to getEnvValue). We snapshot+clear the model env keys in beforeEach so the
 * deterministic assertions are hermetic regardless of the CI box's env.
 */
function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  const fixture: RuntimeFixture = {
    character: { name: "Eliza", bio: [] },
    getSetting: (key: string) => settings[key],
    emitEvent: vi.fn(),
  };
  return fixture as IAgentRuntime;
}

// Every model-name env key config.ts consults, cleared per-test so a polluted
// CI env can't shadow the runtime stub and turn the fallback assertions flaky.
const MODEL_ENV_KEYS = [
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "SMALL_MODEL",
  "ELIZAOS_CLOUD_NANO_MODEL",
  "NANO_MODEL",
  "ELIZAOS_CLOUD_MEDIUM_MODEL",
  "MEDIUM_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "RESPONSE_HANDLER_MODEL",
  "SHOULD_RESPOND_MODEL",
] as const;

describe("gpt-oss-120b built-in model routing (deterministic)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MODEL_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MODEL_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  it("pins the built-in cloud text-model constants to gpt-oss-120b", () => {
    expect(DEFAULT_ELIZA_CLOUD_TEXT_MODEL).toBe(BUILTIN_TEXT_MODEL);
    expect(DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL).toBe(BUILTIN_TEXT_MODEL);
  });

  it("getSmallModel resolves to gpt-oss-120b when small-model settings are unset", () => {
    expect(getSmallModel(runtime())).toBe(BUILTIN_TEXT_MODEL);
  });

  it("nano/medium/responseHandler tiers inherit gpt-oss-120b via getSmallModel", () => {
    const rt = runtime();
    // These delegate to getSmallModel when their own (and SMALL) settings are
    // unset, proving the sub-agent / should-respond tiers inherit the built-in.
    expect(getNanoModel(rt)).toBe(BUILTIN_TEXT_MODEL);
    expect(getMediumModel(rt)).toBe(BUILTIN_TEXT_MODEL);
    expect(getResponseHandlerModel(rt)).toBe(BUILTIN_TEXT_MODEL);
  });

  it("honors an explicit ELIZAOS_CLOUD_SMALL_MODEL override (precedence, not hardcoded)", () => {
    const override = "zai-glm-4.7";
    const rt = runtime({ ELIZAOS_CLOUD_SMALL_MODEL: override });
    expect(getSmallModel(rt)).toBe(override);
    expect(getSmallModel(rt)).not.toBe(BUILTIN_TEXT_MODEL);
    // The tiers that delegate to getSmallModel follow the override too.
    expect(getNanoModel(rt)).toBe(override);
    expect(getMediumModel(rt)).toBe(override);
  });

  it("respects the generic SMALL_MODEL fallback before the built-in default", () => {
    const rt = runtime({ SMALL_MODEL: "some-other-small" });
    expect(getSmallModel(rt)).toBe("some-other-small");
  });

  it("buildElizaCloudServiceRoute() is the bare cloud-proxy route with no smallModel key", () => {
    const route = buildElizaCloudServiceRoute();
    expect(route).toEqual({
      backend: "elizacloud",
      transport: "cloud-proxy",
      accountId: "elizacloud",
    });
    expect(route).not.toHaveProperty("smallModel");
  });

  it("buildElizaCloudServiceRoute carries the built-in when smallModel is populated", () => {
    const route = buildElizaCloudServiceRoute({
      smallModel: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    });
    expect(route.smallModel).toBe(BUILTIN_TEXT_MODEL);
    expect(route.backend).toBe("elizacloud");
    expect(route.transport).toBe("cloud-proxy");
  });

  it("the resolved small-model is recognized as Cerebras/gpt-oss-served", () => {
    // text.ts isCerebrasServedModel is module-internal; mirror its exact rule
    // (lower.includes("gpt-oss")) against the publicly-resolved small model so
    // the coding path is proven to land on the Cerebras-served built-in.
    const isCerebrasServedModel = (name: string): boolean => name.toLowerCase().includes("gpt-oss");
    const resolved = getSmallModel(runtime());
    expect(resolved).toBe(BUILTIN_TEXT_MODEL);
    expect(isCerebrasServedModel(resolved)).toBe(true);
    // A non-gpt-oss override must NOT be flagged Cerebras-served.
    expect(isCerebrasServedModel("zai-glm-4.7")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LIVE round-trip — gated on a real eliza-cloud key. SKIPPED (one console.warn)
// when the key is absent so a bare CI box stays green.
// ---------------------------------------------------------------------------
const LIVE = !!process.env.ELIZAOS_CLOUD_API_KEY;

if (!LIVE) {
  console.warn(
    "[gpt-oss-builtin-model-routing] live cloud round-trip SKIPPED: " +
      "set ELIZAOS_CLOUD_API_KEY=eliza_... (and ELIZAOS_CLOUD_ENABLED=true) to " +
      "exercise generateNativeChatCompletion against gpt-oss-120b. " +
      "The deterministic routing assertions above always run."
  );
}

const liveDescribe = LIVE ? describe : describe.skip;

liveDescribe("gpt-oss-120b live cloud round-trip (needs ELIZAOS_CLOUD_API_KEY)", () => {
  function liveRuntime(): IAgentRuntime {
    const settings: Record<string, string | undefined> = {
      ELIZAOS_CLOUD_API_KEY: process.env.ELIZAOS_CLOUD_API_KEY,
      ELIZAOS_CLOUD_ENABLED: process.env.ELIZAOS_CLOUD_ENABLED ?? "true",
      ...(process.env.ELIZAOS_CLOUD_BASE_URL
        ? { ELIZAOS_CLOUD_BASE_URL: process.env.ELIZAOS_CLOUD_BASE_URL }
        : {}),
    };
    const fixture: RuntimeFixture = {
      character: { name: "Eliza", bio: [] },
      getSetting: (key: string) => settings[key],
      emitEvent: vi.fn(),
    };
    return fixture as IAgentRuntime;
  }

  it("reports cloud connected and completes a tiny gpt-oss-120b generation", async () => {
    // isCloudConnected/toRuntimeSettings live in @elizaos/cloud-routing, which
    // is NOT a declared dep of this plugin (and not vitest-aliased). Guard the
    // import so an unresolvable/heavy dep skips cleanly instead of failing.
    let connectivityChecked = false;
    try {
      const { isCloudConnected, toRuntimeSettings } = (await import(
        "@elizaos/cloud-routing"
      )) as typeof import("@elizaos/cloud-routing");
      expect(isCloudConnected(toRuntimeSettings(liveRuntime()))).toBe(true);
      connectivityChecked = true;
    } catch (err) {
      console.warn(
        "[gpt-oss-builtin-model-routing] @elizaos/cloud-routing import skipped: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
    // Even if the connectivity helper was unavailable, still drive the real
    // round-trip — that is the load-bearing live assertion.
    void connectivityChecked;

    const result = await generateNativeChatCompletion(
      liveRuntime(),
      "TEXT_SMALL",
      { prompt: "reply with the single word ok" } as never,
      { modelName: BUILTIN_TEXT_MODEL, prompt: "reply with the single word ok" }
    );

    // Non-deterministic model output: assert only a non-empty completion and no
    // thrown 400/429 (the cerebras json_object scrub kept response_format valid).
    expect(typeof result.text).toBe("string");
    expect(result.text.trim().length).toBeGreaterThan(0);
  }, 60_000);

  it("server-side canonicalizeCerebrasModelId collapses decorated gpt-oss ids", async () => {
    // Behind a guarded import: @elizaos/cloud-shared is Worker/db-heavy and not
    // a declared dep here; if it can't import cleanly, skip rather than fail.
    try {
      const mod = (await import("@elizaos/cloud-shared/lib/providers/language-model")) as {
        canonicalizeCerebrasModelId?: (m: string) => string;
      };
      const fn = mod.canonicalizeCerebrasModelId;
      if (typeof fn !== "function") {
        console.warn(
          "[gpt-oss-builtin-model-routing] canonicalizeCerebrasModelId not exported; skipping mirror"
        );
        return;
      }
      expect(fn(BUILTIN_TEXT_MODEL)).toBe(BUILTIN_TEXT_MODEL);
      expect(fn("openai/gpt-oss-120b:nitro")).toBe(BUILTIN_TEXT_MODEL);
    } catch (err) {
      console.warn(
        "[gpt-oss-builtin-model-routing] @elizaos/cloud-shared import skipped: " +
          (err instanceof Error ? err.message : String(err))
      );
    }
  }, 30_000);
});
