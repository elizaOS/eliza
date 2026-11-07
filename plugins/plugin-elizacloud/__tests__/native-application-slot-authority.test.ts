/** Launcher slot selection must retain absent and invalid values at the SDK boundary. */
import { applyNativeApplicationInferenceHeaders } from "@elizaos/cloud-sdk";
import type { IAgentRuntime } from "@elizaos/core";
import { createPreparedModelRequestGuard } from "@elizaos/core/runtime/prepared-model-request";
import {
  DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "@elizaos/host/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "../src/cloud-config/dev-cloud-env-authority";
import { registerTextInferenceModels } from "../src/index";
import {
  getActionPlannerModel,
  getImageDescriptionModel,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getNativeApplicationSlot,
  getResponseHandlerModel,
  getResponseModel,
  getSetting,
  getSmallModel,
  resolveCloudSdkAuthorityTuple,
} from "../src/utils/config";
import { withNativeFundingAuthority } from "../src/utils/native-funding";

const keys = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_APPLICATION_SLOT",
  "ELIZAOS_CLOUD_USE_INFERENCE",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_NANO_MODEL",
  "ELIZAOS_CLOUD_MEDIUM_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_MEGA_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
  "ELIZAOS_CLOUD_PLANNER_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_MODEL",
  "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL",
  "ELIZAOS_CLOUD_EMBEDDING_MODEL",
  "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS",
  "SMALL_MODEL",
  "NANO_MODEL",
  "MEDIUM_MODEL",
  "LARGE_MODEL",
  "MEGA_MODEL",
  "RESPONSE_HANDLER_MODEL",
  "SHOULD_RESPOND_MODEL",
  "ACTION_PLANNER_MODEL",
  "PLANNER_MODEL",
  "RESPONSE_MODEL",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

function runtimeWithSlot(value: string | undefined): IAgentRuntime {
  return {
    getSetting: (key: string) => (key === "ELIZAOS_CLOUD_APPLICATION_SLOT" ? value : undefined),
  } as IAgentRuntime;
}

function sealedRuntime(): IAgentRuntime {
  const snapshot = captureDevCloudEnvAuthoritySnapshot(process.env);
  if (!snapshot) throw new Error("Expected launcher authority");
  return {
    // Match the agent runtime's sealed overlay, including its absent-value sentinel.
    getSetting: (key: string) =>
      key.startsWith("ELIZAOS_CLOUD_") ? (snapshot.values[key] ?? "") : undefined,
  } as IAgentRuntime;
}

function prepareModel(model: string) {
  const body = { model, messages: [{ role: "user", content: "Hi" }] };
  return createPreparedModelRequestGuard({
    provider: "eliza-cloud",
    model,
    serializeRequest: () => JSON.stringify(body),
  });
}

function inferenceHeaders(runtime: IAgentRuntime, path: string): Headers {
  const headers = new Headers({ "Idempotency-Key": "native:authority-regression" });
  applyNativeApplicationInferenceHeaders({
    slotKey: getNativeApplicationSlot(runtime),
    method: "POST",
    path,
    headers,
  });
  return headers;
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of keys) delete process.env[key];
  // A test must never reach a provider or Cloud, including through a future refactor.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network call");
    })
  );
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("native application slot launcher authority", () => {
  it.each(["", "stale-product"])(
    "keeps an absent sealed slot absent despite runtime value %j and late env mutation",
    async (runtimeValue) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
      captureDevCloudEnvAuthoritySnapshot(process.env);
      process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = "late-product";
      const runtime = runtimeWithSlot(runtimeValue);
      // The prior getter forwarded the runtime overlay's empty string to the real SDK.
      if (runtimeValue === "") {
        expect(() =>
          applyNativeApplicationInferenceHeaders({
            slotKey: runtime.getSetting("ELIZAOS_CLOUD_APPLICATION_SLOT") as string,
            method: "POST",
            path: "/chat/completions",
            headers: new Headers(),
          })
        ).toThrow("Select a configured application product");
      }
      // The sealed overlay's "" sentinel reads as absent; slot selection itself
      // never trusts a runtime value over the frozen launcher tuple.
      if (runtimeValue === "") {
        expect(getSetting(runtime, "ELIZAOS_CLOUD_APPLICATION_SLOT")).toBeUndefined();
      }
      expect(getNativeApplicationSlot(runtime)).toBeUndefined();
      for (const path of ["/chat/completions", "/embeddings"]) {
        expect(inferenceHeaders(runtime, path).has("X-Eliza-Application-Slot")).toBe(false);
      }
      const failure = new Error("Original operation failure");
      await expect(
        withNativeFundingAuthority(runtime, async () => {
          throw failure;
        })
      ).rejects.toBe(failure);
    }
  );

  it("retains a selected launcher product and its funding failure fence", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = "selected-product";
    captureDevCloudEnvAuthoritySnapshot(process.env);
    process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = "late-product";
    const runtime = runtimeWithSlot("stale-product");
    for (const path of ["/chat/completions", "/embeddings"]) {
      expect(inferenceHeaders(runtime, path).get("X-Eliza-Application-Slot")).toBe(
        "selected-product"
      );
    }
    await expect(
      withNativeFundingAuthority(runtime, async () => {
        throw new Error("failure");
      })
    ).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
  });

  it.each(["", " ", " invalid-product", "bad/product"])(
    "preserves explicitly invalid launcher selection %j for SDK rejection",
    async (slot) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
      process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = slot;
      const runtime = runtimeWithSlot("stale-product");
      expect(getNativeApplicationSlot(runtime)).toBe(slot);
      for (const path of ["/chat/completions", "/embeddings"]) {
        expect(() => inferenceHeaders(runtime, path)).toThrow(
          "Select a configured application product"
        );
      }
      await expect(
        withNativeFundingAuthority(runtime, async () => {
          throw new Error("failure");
        })
      ).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
    }
  );

  it("retains unmanaged runtime selection and its funding fence outside dev authority", async () => {
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_APPLICATION_SLOT = "environment-product";
    const runtime = runtimeWithSlot("runtime-product");
    expect(getNativeApplicationSlot(runtime)).toBe("runtime-product");
    expect(inferenceHeaders(runtime, "/chat/completions").get("X-Eliza-Application-Slot")).toBe(
      "runtime-product"
    );
    await expect(
      withNativeFundingAuthority(runtime, async () => {
        throw new Error("failure");
      })
    ).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
  });
});

describe("Cloud role models under the sealed launcher overlay", () => {
  const roles = [
    ["ELIZAOS_CLOUD_SMALL_MODEL", getSmallModel, DEFAULT_ELIZA_CLOUD_TEXT_MODEL],
    ["ELIZAOS_CLOUD_NANO_MODEL", getNanoModel, DEFAULT_ELIZA_CLOUD_TEXT_MODEL],
    ["ELIZAOS_CLOUD_MEDIUM_MODEL", getMediumModel, DEFAULT_ELIZA_CLOUD_TEXT_MODEL],
    ["ELIZAOS_CLOUD_LARGE_MODEL", getLargeModel, DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL],
    ["ELIZAOS_CLOUD_MEGA_MODEL", getMegaModel, DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL],
    [
      "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
      getResponseHandlerModel,
      DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
    ],
    [
      "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
      getActionPlannerModel,
      DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL,
    ],
    ["ELIZAOS_CLOUD_RESPONSE_MODEL", getResponseModel, DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL],
  ] as const;

  it.each(roles)(
    "prepares %s with its existing default despite the runtime sentinel",
    (key, read, expected) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
      const runtime = sealedRuntime();
      expect(runtime.getSetting(key)).toBe("");
      // The actual Core guard reproduces the observed zero-dispatch failure.
      expect(() => prepareModel(runtime.getSetting(key) as string)).toThrow(
        "Prepared model request needs provider and model ids"
      );
      const model = read(runtime);
      expect(model).toBe(expected);
      const guard = prepareModel(model);
      expect(guard.budget).toMatchObject({ provider: "eliza-cloud", model: expected });
      guard.assertBeforeAttempt();
    }
  );

  it("keeps generic aliases and supplied defaults available for absent owned settings", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.SMALL_MODEL = "generic-small";
    const runtime = sealedRuntime();
    expect(getSmallModel(runtime)).toBe("generic-small");
    expect(getNanoModel(runtime)).toBe("generic-small");
    expect(getImageDescriptionModel(runtime)).toBe("gpt-5.4-mini");
    process.env.SMALL_MODEL = "late-generic-small";
    expect(getSmallModel(runtime)).toBe("late-generic-small");
  });

  it("freezes selected role ids and ignores late owned environment mutations", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = "qwen-3.8-27b";
    const runtime = sealedRuntime();
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = "late-small";
    process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL = "late-handler";
    expect(getSmallModel(runtime)).toBe("qwen-3.8-27b");
    expect(getResponseHandlerModel(runtime)).toBe("qwen-3.8-27b");
    expect(prepareModel(getResponseHandlerModel(runtime)).budget.model).toBe("qwen-3.8-27b");
  });

  it("uses the same canonical key spelling as the sealed runtime", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = "qwen-3.8-27b";
    const runtime = sealedRuntime();
    expect(getSetting(runtime, "elizaos_cloud_small_model")).toBe("qwen-3.8-27b");
  });

  it("preserves the selected Cloud route through bare small and large model aliases", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.SMALL_MODEL = "qwen-3.8-27b";
    process.env.LARGE_MODEL = "qwen-3.8-27b";
    const runtime = sealedRuntime();
    for (const [, read] of roles) {
      const guard = prepareModel(read(runtime));
      expect(guard.budget.model).toBe("qwen-3.8-27b");
      guard.assertBeforeAttempt();
    }
  });

  it("retains the embedding model and dimension defaults used by the embedding handler", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    const runtime = sealedRuntime();
    expect(runtime.getSetting("ELIZAOS_CLOUD_EMBEDDING_MODEL")).toBe("");
    expect(getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_MODEL", "bge-small-en-v1.5")).toBe(
      "bge-small-en-v1.5"
    );
    expect(getSetting(runtime, "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS", "384")).toBe("384");
  });

  it.each(["", " "])(
    "preserves explicitly invalid model %j for the real prepared guard",
    (model) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
      process.env.ELIZAOS_CLOUD_SMALL_MODEL = model;
      const runtime = sealedRuntime();
      expect(getSmallModel(runtime)).toBe(model);
      expect(() => prepareModel(getSmallModel(runtime))).toThrow(
        "Prepared model request needs provider and model ids"
      );
    }
  );

  it.each(["offline", "staging-default"])("retains the %s outbound block", (authority) => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
    const runtime = sealedRuntime();
    expect(resolveCloudSdkAuthorityTuple(runtime).outboundAllowed).toBe(false);
    expect(getNativeApplicationSlot(runtime)).toBeUndefined();
    expect(inferenceHeaders(runtime, "/chat/completions").has("X-Eliza-Application-Slot")).toBe(
      false
    );
  });

  it("keeps the overlay's derived inference opt-out so a direct text route owns the brain", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    const snapshot = captureDevCloudEnvAuthoritySnapshot(process.env);
    if (!snapshot) throw new Error("Expected launcher authority");
    expect(snapshot.values.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
    const registerModel = vi.fn();
    const runtime = {
      // The agent overlay sets this for a direct llmText route; the launcher never did.
      getSetting: (key: string) =>
        key === "ELIZAOS_CLOUD_USE_INFERENCE"
          ? "false"
          : key.startsWith("ELIZAOS_CLOUD_")
            ? (snapshot.values[key] ?? "")
            : undefined,
      registerModel,
    } as unknown as IAgentRuntime;
    expect(getSetting(runtime, "ELIZAOS_CLOUD_USE_INFERENCE")).toBe("false");
    registerTextInferenceModels(runtime);
    expect(registerModel).not.toHaveBeenCalled();
  });

  it("retains ordinary runtime precedence without a launcher authority", () => {
    process.env.ELIZAOS_CLOUD_SMALL_MODEL = "environment-small";
    const runtime = {
      getSetting: (key: string) =>
        key === "ELIZAOS_CLOUD_SMALL_MODEL" ? "runtime-small" : undefined,
    } as IAgentRuntime;
    expect(getSmallModel(runtime)).toBe("runtime-small");
  });
});
