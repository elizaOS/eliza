/**
 * Scenario helper that builds device-support evidence from the checked-in
 * orchestrator device-support matrix and asserts every unsupported device profile
 * exposes only the sandbox stub action with the matrix's expected refusal reason.
 */
import {
  createTerminalUnsupportedTasksAction,
  tasksSandboxStubAction,
} from "../../../src/actions/sandbox-stub.js";
import {
  ORCHESTRATOR_BACKENDS,
  ORCHESTRATOR_DEVICE_SUPPORT_MATRIX,
} from "../../../src/services/orchestrator-device-support-matrix.js";

type StubCheck = {
  profileId: string;
  expectedReason: string;
  actualReason: string | undefined;
  callbackText: string | undefined;
};

export type DeviceSupportScenarioEvidence = {
  matrix: Array<{
    id: string;
    supported: boolean;
    reason?: string;
    backends: string[];
  }>;
  stubs: StubCheck[];
};

function requireRow(id: string) {
  const row = ORCHESTRATOR_DEVICE_SUPPORT_MATRIX.find((r) => r.id === id);
  if (!row) throw new Error(`device support matrix is missing ${id}`);
  return row;
}

async function runUnsupportedStub(
  profileId: string,
  expectedReason: string,
  action: ReturnType<typeof createTerminalUnsupportedTasksAction>,
): Promise<StubCheck> {
  let callbackText: string | undefined;
  const result = await action.handler(
    {} as never,
    {} as never,
    undefined,
    undefined,
    async (content) => {
      callbackText = content.text;
      return [];
    },
  );
  const actualReason = (result?.data as { reason?: string } | undefined)
    ?.reason;
  if (actualReason !== expectedReason) {
    throw new Error(
      `${profileId} stub reason expected ${expectedReason}, saw ${actualReason}`,
    );
  }
  if (!callbackText || !result?.text?.includes(callbackText)) {
    throw new Error(`${profileId} stub did not return callback text cleanly`);
  }
  return { profileId, expectedReason, actualReason, callbackText };
}

async function runStoreStub(): Promise<StubCheck> {
  let callbackText: string | undefined;
  const result = await tasksSandboxStubAction.handler(
    {} as never,
    {} as never,
    undefined,
    undefined,
    async (content) => {
      callbackText = content.text;
      return [];
    },
  );
  const actualReason = (result?.data as { reason?: string } | undefined)
    ?.reason;
  if (actualReason !== "STORE_BUILD_BLOCKED") {
    throw new Error(
      `store stub reason expected STORE_BUILD_BLOCKED, saw ${actualReason}`,
    );
  }
  if (!callbackText || !result?.text?.includes(callbackText)) {
    throw new Error("store stub did not return callback text cleanly");
  }
  return {
    profileId: "store",
    expectedReason: "STORE_BUILD_BLOCKED",
    actualReason,
    callbackText,
  };
}

export async function buildDeviceSupportScenarioEvidence(): Promise<DeviceSupportScenarioEvidence> {
  const desktop = requireRow("desktop");
  const ios = requireRow("ios");
  const store = requireRow("store");
  const androidStore = requireRow("android-store");
  const androidLocalYolo = requireRow("android-local-yolo");

  if (!desktop.support.supported) {
    throw new Error("desktop profile must support local coding-agent spawn");
  }
  if (desktop.backends.length !== ORCHESTRATOR_BACKENDS.length) {
    throw new Error("desktop profile must expose every orchestrator backend");
  }
  if (androidLocalYolo.support.reason !== "missing_acp_runtime") {
    throw new Error(
      `Android local-yolo reason expected missing_acp_runtime, saw ${androidLocalYolo.support.reason}`,
    );
  }
  if (androidLocalYolo.backends.length !== 0) {
    throw new Error("Android must not expose unstaged orchestrator backends");
  }
  if (ios.support.reason !== "vanilla_mobile") {
    throw new Error(
      `iOS reason expected vanilla_mobile, saw ${ios.support.reason}`,
    );
  }
  if (store.support.reason !== "store_build") {
    throw new Error(
      `store reason expected store_build, saw ${store.support.reason}`,
    );
  }
  if (androidStore.support.reason !== "missing_acp_runtime") {
    throw new Error(
      `Android reason expected missing_acp_runtime, saw ${androidStore.support.reason}`,
    );
  }

  const stubs = [
    await runUnsupportedStub(
      "ios",
      "MOBILE_TERMINAL_UNSUPPORTED",
      createTerminalUnsupportedTasksAction(ios.support),
    ),
    await runStoreStub(),
    await runUnsupportedStub(
      "android-store",
      "ANDROID_ACP_RUNTIME_UNAVAILABLE",
      createTerminalUnsupportedTasksAction(androidStore.support),
    ),
  ];

  return {
    matrix: ORCHESTRATOR_DEVICE_SUPPORT_MATRIX.map((row) => ({
      id: row.id,
      supported: row.support.supported,
      ...(row.support.reason ? { reason: row.support.reason } : {}),
      backends: [...row.backends],
    })),
    stubs,
  };
}
