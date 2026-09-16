/** Verifies clearPersistedLocalRuntimeCommitment through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Reversal-cleanup coverage (#14390): backing out of an un-finished local
 * runtime pick must clear the persisted runtime mode + local active server
 * and stop the mobile agent service, while never touching a cloud/remote
 * commitment. Real persistence + runtime-mode modules against jsdom
 * localStorage; only the platform constant and the native Agent bridge are
 * substituted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAndroid: true,
  isIOS: false,
  agentStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../platform/init", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/init")>();
  return {
    ...actual,
    get isAndroid() {
      return mocks.isAndroid;
    },
    get isIOS() {
      return mocks.isIOS;
    },
  };
});

vi.mock("../bridge/native-plugins", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../bridge/native-plugins")>();
  return {
    ...actual,
    getAgentPlugin: () => ({ stop: mocks.agentStop }),
  };
});

import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  persistMobileRuntimeMode,
  readPersistedMobileRuntimeMode,
} from "./mobile-runtime-mode";
import {
  clearPersistedLocalRuntimeCommitment,
  revertLocalRuntimeCommitment,
  revertLocalRuntimeCommitmentBeforeCloud,
} from "./revert-local-runtime-commitment";

// This jsdom env exposes `window.localStorage` as an object without methods;
// install a real in-memory Storage (mirrors `first-run.test.ts`).
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

function seedLocalCommitment(): void {
  persistMobileRuntimeMode("local");
  savePersistedActiveServer({
    id: ANDROID_LOCAL_AGENT_SERVER_ID,
    kind: "remote",
    label: ANDROID_LOCAL_AGENT_LABEL,
    apiBase: ANDROID_LOCAL_AGENT_IPC_BASE,
  });
}

beforeEach(() => {
  ensureLocalStorage().clear();
  mocks.isAndroid = true;
  mocks.isIOS = false;
  mocks.agentStop.mockClear();
  mocks.agentStop.mockResolvedValue({ ok: true });
});

afterEach(() => {
  ensureLocalStorage().clear();
  vi.unstubAllGlobals();
});

describe("owned Local to Cloud reversal", () => {
  const options = { revalidate: () => {}, acceptClearedServer: () => {} };

  it("preserves a build-pinned remote target and refuses Cloud cleanup", async () => {
    vi.stubGlobal(
      "__ELIZA_BUILD_CONFIGURED_REMOTE_API_BASE__",
      "https://pinned.example.test",
    );
    persistMobileRuntimeMode("local");
    const pinned = {
      id: ANDROID_LOCAL_AGENT_SERVER_ID,
      kind: "remote" as const,
      label: "Pinned runtime",
      apiBase: "https://pinned.example.test",
    };
    expect(savePersistedActiveServer(pinned)).toBe(true);
    await expect(
      revertLocalRuntimeCommitmentBeforeCloud(options),
    ).rejects.toThrow();
    expect(loadPersistedActiveServer()).toEqual(pinned);
    expect(readPersistedMobileRuntimeMode()).toBe("local");
    expect(mocks.agentStop).not.toHaveBeenCalled();
  });

  it("keeps the local mode retryable when the native stop refuses, then completes on acknowledgement", async () => {
    seedLocalCommitment();
    mocks.agentStop.mockResolvedValueOnce({ ok: false });
    await expect(
      revertLocalRuntimeCommitmentBeforeCloud(options),
    ).rejects.toThrow();
    expect(readPersistedMobileRuntimeMode()).toBe("local");
    await revertLocalRuntimeCommitmentBeforeCloud(options);
    expect(mocks.agentStop).toHaveBeenCalledTimes(2);
    expect(readPersistedMobileRuntimeMode()).toBeNull();
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("does not erase a newer runtime choice while the mobile stop is pending", async () => {
    seedLocalCommitment();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.agentStop.mockImplementationOnce(async () => {
      await held;
      return { ok: true };
    });
    const outcome = revertLocalRuntimeCommitmentBeforeCloud(options).catch(
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() => expect(mocks.agentStop).toHaveBeenCalledOnce());
      persistMobileRuntimeMode("remote-mac");
      release();
      expect(await outcome).toBeInstanceOf(Error);
      expect(readPersistedMobileRuntimeMode()).toBe("remote-mac");
    } finally {
      release();
      await outcome;
    }
  });
});

describe("clearPersistedLocalRuntimeCommitment", () => {
  it("clears a persisted local mode and the local active server", () => {
    seedLocalCommitment();

    const cleared = clearPersistedLocalRuntimeCommitment();

    expect(cleared).toEqual({
      clearedRuntimeMode: true,
      clearedActiveServer: true,
    });
    expect(readPersistedMobileRuntimeMode()).toBeNull();
    expect(localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY)).toBeNull();
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("clears a hybrid (local runtime + cloud inference) commitment too", () => {
    persistMobileRuntimeMode("cloud-hybrid");

    const cleared = clearPersistedLocalRuntimeCommitment();

    expect(cleared.clearedRuntimeMode).toBe(true);
    expect(readPersistedMobileRuntimeMode()).toBeNull();
  });

  it("never touches a cloud mode or a non-local active server", () => {
    persistMobileRuntimeMode("cloud");
    savePersistedActiveServer({
      id: "cloud:agent-1",
      kind: "cloud",
      label: "Cloud agent",
      apiBase: "https://agent.example.test",
    });

    const cleared = clearPersistedLocalRuntimeCommitment();

    expect(cleared).toEqual({
      clearedRuntimeMode: false,
      clearedActiveServer: false,
    });
    expect(readPersistedMobileRuntimeMode()).toBe("cloud");
    expect(loadPersistedActiveServer()?.id).toBe("cloud:agent-1");
  });

  it("is a no-op on a fresh state", () => {
    const cleared = clearPersistedLocalRuntimeCommitment();
    expect(cleared).toEqual({
      clearedRuntimeMode: false,
      clearedActiveServer: false,
    });
  });
});

describe("revertLocalRuntimeCommitment", () => {
  it("stops the mobile agent service when a local mode was committed", async () => {
    seedLocalCommitment();

    const cleared = await revertLocalRuntimeCommitment();

    expect(cleared.clearedRuntimeMode).toBe(true);
    expect(mocks.agentStop).toHaveBeenCalledTimes(1);
    expect(readPersistedMobileRuntimeMode()).toBeNull();
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("does not call the stop bridge when nothing local was committed", async () => {
    persistMobileRuntimeMode("cloud");

    await revertLocalRuntimeCommitment();

    expect(mocks.agentStop).not.toHaveBeenCalled();
    expect(readPersistedMobileRuntimeMode()).toBe("cloud");
  });

  it("still clears the persisted commitment when the stop bridge rejects", async () => {
    seedLocalCommitment();
    mocks.agentStop.mockRejectedValueOnce(new Error("service not running"));

    const cleared = await revertLocalRuntimeCommitment();

    expect(cleared.clearedRuntimeMode).toBe(true);
    expect(readPersistedMobileRuntimeMode()).toBeNull();
    expect(loadPersistedActiveServer()).toBeNull();
  });

  it("skips the stop bridge off-mobile but still clears persisted records", async () => {
    mocks.isAndroid = false;
    mocks.isIOS = false;
    persistMobileRuntimeMode("local");

    const cleared = await revertLocalRuntimeCommitment();

    expect(cleared.clearedRuntimeMode).toBe(true);
    expect(mocks.agentStop).not.toHaveBeenCalled();
    expect(readPersistedMobileRuntimeMode()).toBeNull();
  });
});
