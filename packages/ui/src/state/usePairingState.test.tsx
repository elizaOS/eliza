/**
 * Verifies the pairing hook's client-side wire contract with deterministic API
 * and credential-persistence boundaries under jsdom.
 *
 * @vitest-environment jsdom
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePairingState } from "./usePairingState";

const mocks = vi.hoisted(() => ({
  client: {
    pair: vi.fn(),
    getBaseUrl: vi.fn(() => "https://runtime.example.test"),
    setToken: vi.fn(),
  },
  persistActiveServerCredential: vi.fn(),
}));

vi.mock("../api", () => ({ client: mocks.client }));
vi.mock("./active-server-credential", () => ({
  persistActiveServerCredential: mocks.persistActiveServerCredential,
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setPairingCode(
  result: ReturnType<
    typeof renderHook<ReturnType<typeof usePairingState>, void>
  >["result"],
  code: string,
): void {
  act(() => result.current.setPairingCodeInput(code));
}

describe("usePairingState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getBaseUrl.mockReturnValue("https://runtime.example.test");
    mocks.persistActiveServerCredential.mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it.each([
    [410, "Pairing code expired. Generate a new code and try again."],
    [429, "Too many attempts. Try again later."],
    [500, "Pairing failed. Check the code and try again."],
  ])(
    "maps HTTP %i and clears the error when the next request starts",
    async (status, message) => {
      mocks.client.pair.mockRejectedValueOnce({ status });
      const nextRequest = deferred<{ token: string }>();
      mocks.client.pair.mockImplementationOnce(() => nextRequest.promise);
      const { result } = renderHook(() => usePairingState());
      setPairingCode(result, "PAIR-1234");

      await act(async () => result.current.handlePairingSubmit());
      expect(result.current.state.pairingError).toBe(message);

      let retry!: Promise<void>;
      act(() => {
        retry = result.current.handlePairingSubmit();
      });
      expect(result.current.state.pairingError).toBeNull();
      expect(result.current.state.pairingBusy).toBe(true);

      nextRequest.reject({ status: 500 });
      await act(async () => retry);
    },
  );

  it("rejects empty input before calling the pairing API", async () => {
    const { result } = renderHook(() => usePairingState());
    setPairingCode(result, "   \t ");

    await act(async () => result.current.handlePairingSubmit());

    expect(result.current.state.pairingError).toBe(
      "Enter the pairing code from your server.",
    );
    expect(mocks.client.pair).not.toHaveBeenCalled();
  });

  it("suppresses a second submit while the first request is in flight", async () => {
    const request = deferred<{ token: string }>();
    mocks.client.pair.mockImplementation(() => request.promise);
    const { result } = renderHook(() => usePairingState());
    setPairingCode(result, "PAIR-1234");

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.handlePairingSubmit();
      second = result.current.handlePairingSubmit();
    });

    expect(mocks.client.pair).toHaveBeenCalledTimes(1);
    expect(result.current.state.pairingBusy).toBe(true);

    request.reject({ status: 500 });
    await act(async () => Promise.all([first, second]));
    expect(result.current.state.pairingBusy).toBe(false);
  });

  it("persists the issued credential before installing the client token", async () => {
    const persistence = deferred<void>();
    mocks.client.pair.mockResolvedValue({ token: "paired-token" });
    mocks.persistActiveServerCredential.mockImplementation(
      () => persistence.promise,
    );
    const { result } = renderHook(() => usePairingState());
    setPairingCode(result, "PAIR-1234");

    let submission!: Promise<void>;
    act(() => {
      submission = result.current.handlePairingSubmit();
    });
    await vi.waitFor(() =>
      expect(mocks.persistActiveServerCredential).toHaveBeenCalledWith(
        "paired-token",
        "https://runtime.example.test",
      ),
    );
    expect(mocks.client.setToken).not.toHaveBeenCalled();

    persistence.resolve();
    await act(async () => submission);
    expect(mocks.client.setToken).toHaveBeenCalledWith("paired-token");
  });

  it("retries persistence without consuming the pairing code again", async () => {
    mocks.client.pair.mockResolvedValue({ token: "paired-token" });
    mocks.persistActiveServerCredential
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => usePairingState());
    setPairingCode(result, "PAIR-1234");

    await act(async () => result.current.handlePairingSubmit());

    expect(result.current.state.pairingError).toBe(
      "Pairing succeeded, but this device could not save the connection. Keep this window open and submit again to retry saving.",
    );
    expect(result.current.state.pairingError).not.toBe(
      "Pairing failed. Check the code and try again.",
    );
    expect(mocks.client.pair).toHaveBeenCalledTimes(1);
    expect(mocks.persistActiveServerCredential).toHaveBeenCalledTimes(1);
    expect(mocks.persistActiveServerCredential).toHaveBeenLastCalledWith(
      "paired-token",
      "https://runtime.example.test",
    );
    expect(mocks.client.setToken).not.toHaveBeenCalled();

    await act(async () => result.current.handlePairingSubmit());

    expect(mocks.client.pair).toHaveBeenCalledTimes(1);
    expect(mocks.persistActiveServerCredential).toHaveBeenCalledTimes(2);
    expect(mocks.persistActiveServerCredential).toHaveBeenLastCalledWith(
      "paired-token",
      "https://runtime.example.test",
    );
    expect(mocks.client.setToken).toHaveBeenCalledOnce();
    expect(mocks.client.setToken).toHaveBeenCalledWith("paired-token");
  });
});
