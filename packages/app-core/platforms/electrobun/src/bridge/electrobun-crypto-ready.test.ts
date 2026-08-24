/**
 * Exercises installElectrobunCryptoReadyGuards on the real bridge module with
 * deterministic fake timers: RPC-global truthiness gating, one-sided and
 * repeated installation, non-function value replacement, placeholder
 * self-reference handling, argument forwarding, rejection propagation, and
 * timeout/option-default behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ElectrobunCryptoWindow,
  type ElectrobunDecrypt,
  type ElectrobunEncrypt,
  installElectrobunCryptoReadyGuards,
} from "./electrobun-crypto-ready.ts";

afterEach(() => {
  vi.useRealTimers();
});

interface PromiseOutcome {
  state: "pending" | "resolved" | "rejected";
}

function track<T>(promise: Promise<T> | undefined): PromiseOutcome {
  const outcome: PromiseOutcome = { state: "pending" };
  void promise?.then(
    () => {
      outcome.state = "resolved";
    },
    () => {
      outcome.state = "rejected";
    },
  );
  return outcome;
}

function makeReadyWindow(
  overrides: Partial<ElectrobunCryptoWindow> = {},
): ElectrobunCryptoWindow {
  return {
    __electrobunWebviewId: "webview-1",
    __electrobunRpcSocketPort: 41_000,
    ...overrides,
  };
}

function makeBuiltinEncrypt() {
  return vi.fn(async (message: string) => ({
    encryptedData: `encrypted:${message}`,
    iv: "iv",
    tag: "tag",
  }));
}

function makeBuiltinDecrypt() {
  return vi.fn(
    async (encryptedData: string, iv: string, tag: string) =>
      `decrypted:${encryptedData}:${iv}:${tag}`,
  );
}

describe("installElectrobunCryptoReadyGuards gating", () => {
  it("returns false and installs nothing when the socket RPC globals are falsy", () => {
    const cases: Array<[string, ElectrobunCryptoWindow]> = [
      ["neither global present", {}],
      ["webview id only", { __electrobunWebviewId: "webview-1" }],
      ["socket port only", { __electrobunRpcSocketPort: 41_000 }],
      [
        "empty-string webview id",
        { __electrobunWebviewId: "", __electrobunRpcSocketPort: 41_000 },
      ],
      [
        "zero socket port",
        { __electrobunWebviewId: 1, __electrobunRpcSocketPort: 0 },
      ],
      [
        "both globals null",
        {
          __electrobunWebviewId: null,
          __electrobunRpcSocketPort: null,
        } as unknown as ElectrobunCryptoWindow,
      ],
    ];

    for (const [label, partialWindow] of cases) {
      const globalWindow: ElectrobunCryptoWindow = { ...partialWindow };

      expect(installElectrobunCryptoReadyGuards(globalWindow), label).toBe(
        false,
      );
      expect(globalWindow.__electrobun_encrypt, label).toBeUndefined();
      expect(globalWindow.__electrobun_decrypt, label).toBeUndefined();
    }
  });

  it("treats truthy string globals as transport availability and installs both guards", () => {
    const globalWindow: ElectrobunCryptoWindow = {
      __electrobunWebviewId: "0",
      __electrobunRpcSocketPort: "1234",
    };

    expect(
      installElectrobunCryptoReadyGuards(globalWindow, {
        timeoutMs: 50,
        pollIntervalMs: 5,
      }),
    ).toBe(true);
    expect(typeof globalWindow.__electrobun_encrypt).toBe("function");
    expect(typeof globalWindow.__electrobun_decrypt).toBe("function");
  });
});

describe("installElectrobunCryptoReadyGuards installation", () => {
  it("installs only the encrypt guard and preserves an existing decrypt function", () => {
    const existingDecrypt: ElectrobunDecrypt = async (data, iv, tag) =>
      `${data}:${iv}:${tag}`;
    const globalWindow = makeReadyWindow({
      __electrobun_decrypt: existingDecrypt,
    });

    expect(installElectrobunCryptoReadyGuards(globalWindow)).toBe(true);
    expect(typeof globalWindow.__electrobun_encrypt).toBe("function");
    expect(globalWindow.__electrobun_decrypt).toBe(existingDecrypt);
  });

  it("installs only the decrypt guard and preserves an existing encrypt function", () => {
    const existingEncrypt: ElectrobunEncrypt = async (message) => ({
      encryptedData: message,
      iv: "iv",
      tag: "tag",
    });
    const globalWindow = makeReadyWindow({
      __electrobun_encrypt: existingEncrypt,
    });

    expect(installElectrobunCryptoReadyGuards(globalWindow)).toBe(true);
    expect(typeof globalWindow.__electrobun_decrypt).toBe("function");
    expect(globalWindow.__electrobun_encrypt).toBe(existingEncrypt);
  });

  it("replaces non-function crypto values with callable guards", () => {
    const globalWindow = makeReadyWindow({
      __electrobun_encrypt: "stale-value" as unknown as ElectrobunEncrypt,
      __electrobun_decrypt: null as unknown as ElectrobunDecrypt,
    });

    expect(installElectrobunCryptoReadyGuards(globalWindow)).toBe(true);
    expect(typeof globalWindow.__electrobun_encrypt).toBe("function");
    expect(typeof globalWindow.__electrobun_decrypt).toBe("function");
  });

  it("returns false and preserves both identities when real functions are already installed", () => {
    const existingEncrypt: ElectrobunEncrypt = async (message) => ({
      encryptedData: message,
      iv: "iv",
      tag: "tag",
    });
    const existingDecrypt: ElectrobunDecrypt = async (data, iv, tag) =>
      `${data}:${iv}:${tag}`;
    const globalWindow = makeReadyWindow({
      __electrobun_encrypt: existingEncrypt,
      __electrobun_decrypt: existingDecrypt,
    });

    expect(installElectrobunCryptoReadyGuards(globalWindow)).toBe(false);
    expect(globalWindow.__electrobun_encrypt).toBe(existingEncrypt);
    expect(globalWindow.__electrobun_decrypt).toBe(existingDecrypt);
  });

  it("keeps the first guard identities when installation is repeated", () => {
    const globalWindow = makeReadyWindow();

    expect(installElectrobunCryptoReadyGuards(globalWindow)).toBe(true);
    const firstEncrypt = globalWindow.__electrobun_encrypt;
    const firstDecrypt = globalWindow.__electrobun_decrypt;

    expect(installElectrobunCryptoReadyGuards(globalWindow)).toBe(false);
    expect(globalWindow.__electrobun_encrypt).toBe(firstEncrypt);
    expect(globalWindow.__electrobun_decrypt).toBe(firstDecrypt);
  });
});

describe("installElectrobunCryptoReadyGuards forwarding", () => {
  it("forwards the queued encrypt call to the preload function once installed", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 500,
      pollIntervalMs: 10,
    });
    const pending = globalWindow.__electrobun_encrypt?.("hello");

    const builtin = makeBuiltinEncrypt();
    globalWindow.__electrobun_encrypt = builtin;
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toEqual({
      encryptedData: "encrypted:hello",
      iv: "iv",
      tag: "tag",
    });
    expect(builtin).toHaveBeenCalledTimes(1);
    expect(builtin).toHaveBeenCalledWith("hello");
  });

  it("forwards queued decrypt arguments in order to the preload function", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 500,
      pollIntervalMs: 10,
    });
    const pending = globalWindow.__electrobun_decrypt?.("cipher", "iv", "tag");

    const builtin = makeBuiltinDecrypt();
    globalWindow.__electrobun_decrypt = builtin;
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toBe("decrypted:cipher:iv:tag");
    expect(builtin).toHaveBeenCalledTimes(1);
    expect(builtin).toHaveBeenCalledWith("cipher", "iv", "tag");
  });

  it("propagates a rejection from the installed preload function", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 500,
      pollIntervalMs: 10,
    });
    const pending = globalWindow.__electrobun_encrypt?.("hello");
    const outcome = track(pending);

    globalWindow.__electrobun_encrypt = vi.fn(async () => {
      throw new Error("preload encryption exploded");
    });
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).rejects.toThrow("preload encryption exploded");
    expect(outcome.state).toBe("rejected");
  });
});

describe("installElectrobunCryptoReadyGuards readiness waiting", () => {
  it("leaves the placeholder installed and pending instead of recursing into itself", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 500,
      pollIntervalMs: 10,
    });
    const placeholder = globalWindow.__electrobun_encrypt;

    const pending = placeholder?.("hello");
    const outcome = track(pending);

    await vi.advanceTimersByTimeAsync(100);
    expect(outcome.state).toBe("pending");
    expect(globalWindow.__electrobun_encrypt).toBe(placeholder);

    globalWindow.__electrobun_encrypt = vi.fn(async (message: string) => ({
      encryptedData: `late:${message}`,
      iv: "iv",
      tag: "tag",
    }));
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toEqual({
      encryptedData: "late:hello",
      iv: "iv",
      tag: "tag",
    });
    expect(outcome.state).toBe("resolved");
  });

  it("times out the encrypt guard with the property name and configured duration", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 60,
      pollIntervalMs: 10,
    });
    const pending = globalWindow.__electrobun_encrypt?.("hello");
    const outcome = track(pending);

    await vi.advanceTimersByTimeAsync(50);
    expect(outcome.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).rejects.toThrow(
      "Electrobun preload did not install __electrobun_encrypt within 60ms",
    );
    expect(outcome.state).toBe("rejected");
  });

  it("times out the decrypt guard with the property name and configured duration", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 40,
      pollIntervalMs: 10,
    });
    const pending = globalWindow.__electrobun_decrypt?.("cipher", "iv", "tag");
    const outcome = track(pending);

    await vi.advanceTimersByTimeAsync(80);
    await expect(pending).rejects.toThrow(
      "Electrobun preload did not install __electrobun_decrypt within 40ms",
    );
    expect(outcome.state).toBe("rejected");
  });

  it("rejects immediately when timeoutMs is zero", async () => {
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, { timeoutMs: 0 });
    const encryptPending = globalWindow.__electrobun_encrypt?.("hello");
    const decryptPending = globalWindow.__electrobun_decrypt?.(
      "cipher",
      "iv",
      "tag",
    );
    track(encryptPending);
    track(decryptPending);

    await expect(encryptPending).rejects.toThrow(
      "__electrobun_encrypt within 0ms",
    );
    await expect(decryptPending).rejects.toThrow(
      "__electrobun_decrypt within 0ms",
    );
  });

  it("discovers a late-installed function even with a zero poll interval", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 200,
      pollIntervalMs: 0,
    });
    const pending = globalWindow.__electrobun_encrypt?.("hello");
    const outcome = track(pending);

    globalWindow.__electrobun_encrypt = vi.fn(async (message: string) => ({
      encryptedData: `fast:${message}`,
      iv: "iv",
      tag: "tag",
    }));
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      encryptedData: "fast:hello",
      iv: "iv",
      tag: "tag",
    });
    expect(outcome.state).toBe("resolved");
  });

  it("uses the 5000ms default timeout when options are omitted", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow);
    const pending = globalWindow.__electrobun_encrypt?.("hello");
    const outcome = track(pending);

    await vi.advanceTimersByTimeAsync(4_990);
    expect(outcome.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).rejects.toThrow(
      "did not install __electrobun_encrypt within 5000ms",
    );
    expect(outcome.state).toBe("rejected");
  });

  it("applies nullish option fields through the same defaults", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: undefined,
      pollIntervalMs: undefined,
    });
    const pending = globalWindow.__electrobun_decrypt?.("cipher", "iv", "tag");
    const outcome = track(pending);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).rejects.toThrow(
      "did not install __electrobun_decrypt within 5000ms",
    );
    expect(outcome.state).toBe("rejected");
  });

  it("honors explicit options instead of the defaults", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 25,
      pollIntervalMs: 5,
    });
    const pending = globalWindow.__electrobun_encrypt?.("hello");
    const outcome = track(pending);

    await vi.advanceTimersByTimeAsync(20);
    expect(outcome.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).rejects.toThrow(
      "did not install __electrobun_encrypt within 25ms",
    );
    expect(outcome.state).toBe("rejected");
  });

  it("resolves the ready side independently while the other side keeps waiting", async () => {
    vi.useFakeTimers();
    const globalWindow = makeReadyWindow();

    installElectrobunCryptoReadyGuards(globalWindow, {
      timeoutMs: 100,
      pollIntervalMs: 10,
    });
    const encryptPending = globalWindow.__electrobun_encrypt?.("hello");
    const encryptOutcome = track(encryptPending);
    const decryptPending = globalWindow.__electrobun_decrypt?.(
      "cipher",
      "iv",
      "tag",
    );

    globalWindow.__electrobun_decrypt = vi.fn(
      async (data: string) => `plain:${data}`,
    );
    await vi.advanceTimersByTimeAsync(10);

    await expect(decryptPending).resolves.toBe("plain:cipher");
    expect(encryptOutcome.state).toBe("pending");

    await vi.advanceTimersByTimeAsync(150);
    await expect(encryptPending).rejects.toThrow(
      "__electrobun_encrypt within 100ms",
    );
    expect(encryptOutcome.state).toBe("rejected");
  });
});
