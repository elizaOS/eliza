/**
 * Validates the native result envelope produced by the iOS full-Bun smoke.
 * The host harness uses this contract to reject proxy replies, stale results,
 * incomplete IPC readiness, and responses that did not come from the model.
 */
import { IOS_FULL_BUN_SMOKE_FAILURE_RE } from "./chat-failure-strings.mjs";

const EXPECTED_REPLY = "the ios full bun local backend is running";
const EXPECTED_MODEL_INPUT =
  "In one short sentence, confirm the iOS full Bun local backend is running.";

/** Parses the untrusted native-preference payload into an explicit result or invalid signal. */
export function parseIosFullBunSmokeResult(raw) {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    // error-policy:J3 malformed native preference payloads are explicitly invalid.
    return null;
  }
}

/** Returns the first valid lifecycle timestamp carried by a smoke result. */
export function iosFullBunSmokeResultTimeMs(result) {
  if (!result || typeof result !== "object") return null;
  for (const key of ["updatedAt", "finishedAt", "startedAt"]) {
    const value = result[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object.`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} was not an array.`);
  }
  return value;
}

function normalizeSmokeReply(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Rejects any nominally successful result that lacks the real Bun, IPC,
 * local-inference, model-activation, non-streaming, or streaming proof.
 */
export function assertIosFullBunSmokeSuccess(result) {
  const runtimeStatus = assertObject(
    result.runtimeStatus,
    "iOS full Bun runtimeStatus",
  );
  if (runtimeStatus.ready !== true || runtimeStatus.engine !== "bun") {
    throw new Error(
      `iOS full Bun runtimeStatus was not ready on bun: ${JSON.stringify(runtimeStatus)}`,
    );
  }

  const bridgeStatus = assertObject(
    result.bridgeStatus,
    "iOS full Bun bridgeStatus",
  );
  if (
    bridgeStatus.ready !== true ||
    bridgeStatus.engine !== "bun" ||
    bridgeStatus.transport !== "bun-host-ipc"
  ) {
    throw new Error(
      `iOS full Bun bridgeStatus did not report bun-host-ipc: ${JSON.stringify(bridgeStatus)}`,
    );
  }
  if ("apiPort" in bridgeStatus || "fallbackPort" in bridgeStatus) {
    throw new Error(
      `iOS full Bun bridgeStatus still exposed port metadata: ${JSON.stringify(bridgeStatus)}`,
    );
  }

  const fetchHealth = assertObject(
    result.fetchHealth,
    "iOS full Bun fetchHealth",
  );
  if (fetchHealth.ready !== true || fetchHealth.runtime !== "ok") {
    throw new Error(
      `iOS full Bun fetchHealth was not ready: ${JSON.stringify(fetchHealth)}`,
    );
  }

  const localInference = assertObject(
    result.localInference,
    "iOS full Bun localInference",
  );
  const hub = assertObject(
    localInference.hub,
    "iOS full Bun localInference.hub",
  );
  const hubInstalled = assertArray(
    hub.installed,
    "iOS full Bun localInference.hub.installed",
  );
  const device = assertObject(
    localInference.device,
    "iOS full Bun localInference.device",
  );
  if (
    device.enabled !== true ||
    device.connected !== true ||
    device.transport !== "bun-host-ipc"
  ) {
    throw new Error(
      `iOS full Bun device bridge was not connected over IPC: ${JSON.stringify(device)}`,
    );
  }
  assertArray(device.devices, "iOS full Bun localInference.device.devices");

  const providers = assertArray(
    assertObject(localInference.providers, "iOS full Bun providers").providers,
    "iOS full Bun provider list",
  );
  const capacitorProvider = providers.find(
    (provider) =>
      provider &&
      typeof provider === "object" &&
      provider.id === "capacitor-llama",
  );
  if (!capacitorProvider) {
    throw new Error(
      "iOS full Bun provider list did not include capacitor-llama.",
    );
  }
  const slots = assertArray(
    capacitorProvider.registeredSlots,
    "iOS full Bun capacitor-llama registeredSlots",
  );
  if (!slots.includes("TEXT_SMALL") || !slots.includes("TEXT_LARGE")) {
    throw new Error(
      "iOS full Bun capacitor-llama did not register TEXT_SMALL/TEXT_LARGE.",
    );
  }

  if (typeof result.conversationId !== "string" || !result.conversationId) {
    throw new Error("iOS full Bun smoke did not return a conversationId.");
  }
  const modelInput = assertObject(result.modelInput, "iOS full Bun modelInput");
  if (
    modelInput.text !== EXPECTED_MODEL_INPUT ||
    modelInput.channelType !== "DM" ||
    modelInput.source !== "ios-local"
  ) {
    throw new Error(
      `iOS full Bun modelInput did not match the exercised request: ${JSON.stringify(modelInput)}`,
    );
  }
  const installed = assertArray(
    assertObject(
      localInference.installed,
      "iOS full Bun localInference.installed",
    ).models,
    "iOS full Bun localInference.installed.models",
  );
  if (hubInstalled.length > 0) {
    if (installed.length === 0) {
      throw new Error(
        "iOS full Bun scanner saw an installed model, but /installed returned none.",
      );
    }
    const activatedModel = assertObject(
      localInference.activatedModel,
      "iOS full Bun localInference.activatedModel",
    );
    if (
      activatedModel.status !== "ready" ||
      typeof activatedModel.modelPath !== "string" ||
      !activatedModel.modelPath
    ) {
      throw new Error(
        `iOS full Bun model activation was not ready: ${JSON.stringify(activatedModel)}`,
      );
    }
    const active = assertObject(
      localInference.active,
      "iOS full Bun localInference.active",
    );
    if (active.status !== "ready") {
      throw new Error(
        `iOS full Bun active model was not ready: ${JSON.stringify(active)}`,
      );
    }
  }

  const sendMessage = assertObject(
    result.sendMessage,
    "iOS full Bun sendMessage",
  );
  const reply = String(sendMessage.text ?? sendMessage.reply ?? "");
  if (
    normalizeSmokeReply(reply) !== EXPECTED_REPLY ||
    IOS_FULL_BUN_SMOKE_FAILURE_RE.test(reply)
  ) {
    throw new Error(
      `iOS full Bun sendMessage did not return the expected local model reply: ${JSON.stringify(sendMessage)}`,
    );
  }
  const streamMessage = String(result.streamMessage ?? "");
  if (
    !streamMessage.includes('"type":"done"') ||
    IOS_FULL_BUN_SMOKE_FAILURE_RE.test(streamMessage) ||
    !normalizeSmokeReply(streamMessage).includes(EXPECTED_REPLY)
  ) {
    throw new Error(
      `iOS full Bun stream did not return the expected local model reply: ${streamMessage.slice(0, 500)}`,
    );
  }
}
