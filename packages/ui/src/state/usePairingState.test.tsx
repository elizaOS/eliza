// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { usePairingState } from "./usePairingState";

const mocks = vi.hoisted(() => ({
  pair: vi.fn(),
  getBaseUrl: vi.fn(() => "http://10.0.2.2:31338"),
  getRestAuthToken: vi.fn(() => "test-session" as string | null),
  setToken: vi.fn(),
  persist: vi.fn(),
  resume: vi.fn(),
  scrub: vi.fn(),
}));
vi.mock("../api/client", () => ({ client: mocks }));
vi.mock("./active-server-credential", () => ({
  persistActiveServerCredential: mocks.persist,
  scrubRejectedActiveServerCredential: mocks.scrub,
}));
vi.mock("../first-run/adopt-remote-first-run", () => ({
  resumeRemoteFirstRunAfterPairing: mocks.resume,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBaseUrl.mockReturnValue("http://10.0.2.2:31338");
  mocks.getRestAuthToken.mockReturnValue("test-session");
  mocks.pair.mockResolvedValue({ token: "test-session" });
  mocks.persist.mockResolvedValue(undefined);
  mocks.resume.mockRejectedValue(new Error("Host setup unavailable"));
});

it("retries setup after successful pairing without consuming the pairing code again", async () => {
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("TEST-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.persist).toHaveBeenCalledWith(
    "test-session",
    "http://10.0.2.2:31338",
  );
  expect(mocks.setToken).toHaveBeenCalledWith("test-session");
  expect(mocks.resume.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.setToken.mock.invocationCallOrder[0],
  );
  expect(result.current.state.pairingError).toBe(
    "Paired, but remote setup failed: Host setup unavailable",
  );
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.pair).toHaveBeenCalledTimes(1);
  expect(mocks.resume).toHaveBeenCalledTimes(2);
});

it("does not resume setup when the pairing code is rejected", async () => {
  mocks.pair.mockRejectedValue({ code: "PAIRING_INVALID", status: 401 });
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("BAD-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(result.current.state.pairingError).toContain(
    "pairing code is invalid",
  );
});

it("refreshes the startup coordinator after the paired setup completes", async () => {
  mocks.resume.mockResolvedValue(undefined);
  const onPaired = vi.fn();
  const { result } = renderHook(() => usePairingState(onPaired));
  act(() => result.current.setPairingCodeInput("TEST-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(onPaired).toHaveBeenCalledOnce();
  expect(onPaired.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.resume.mock.invocationCallOrder[0],
  );
  expect(result.current.state.pairingError).toBeNull();
});

it("uses a new pairing code after a previously paired same-base token is revoked", async () => {
  mocks.resume.mockResolvedValue(undefined);
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("FIRST-CODE"));
  await act(() => result.current.handlePairingSubmit());
  mocks.getRestAuthToken.mockReturnValue(null);
  mocks.pair.mockResolvedValue({ token: "replacement-session" });
  act(() => result.current.setPairingCodeInput("NEW-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.pair).toHaveBeenNthCalledWith(2, "NEW-CODE");
  expect(mocks.setToken).toHaveBeenLastCalledWith("replacement-session");
});

it("uses a fresh code when a server at the same address replaces the prior pairing", async () => {
  mocks.resume.mockResolvedValue(undefined);
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("FIRST-CODE"));
  await act(() => result.current.handlePairingSubmit());
  // The old bearer can still be cached during startup against a replaced
  // server. A different entered code is explicit new pairing intent.
  mocks.pair.mockResolvedValue({ token: "replacement-session" });
  act(() => result.current.setPairingCodeInput("NEW-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.pair).toHaveBeenNthCalledWith(2, "NEW-CODE");
  expect(mocks.setToken).toHaveBeenLastCalledWith("replacement-session");
});

it("pairs again after authenticated setup rejects the issued session", async () => {
  mocks.resume.mockRejectedValueOnce({ status: 401 });
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("FIRST-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.scrub).toHaveBeenCalledWith("test-session");
  expect(result.current.state.pairingCodeInput).toBe("");
  expect(result.current.state.pairingError).toContain(
    "Enter a new pairing code",
  );
  mocks.resume.mockResolvedValue(undefined);
  mocks.pair.mockResolvedValue({ token: "replacement-session" });
  act(() => result.current.setPairingCodeInput("NEW-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.pair).toHaveBeenNthCalledWith(2, "NEW-CODE");
  expect(mocks.setToken).toHaveBeenLastCalledWith("replacement-session");
  expect(result.current.state.pairingError).toBeNull();
});

it("retries credential persistence without consuming the one-time code again", async () => {
  mocks.persist.mockRejectedValueOnce(new Error("Storage unavailable"));
  mocks.resume.mockResolvedValue(undefined);
  const onPaired = vi.fn();
  const { result } = renderHook(() => usePairingState(onPaired));
  act(() => result.current.setPairingCodeInput("ONE-TIME-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.resume).not.toHaveBeenCalled();
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.pair).toHaveBeenCalledOnce();
  expect(mocks.persist).toHaveBeenCalledTimes(2);
  expect(onPaired).toHaveBeenCalledOnce();
});

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

it.each([
  [
    { code: "PAIRING_EXPIRED", status: 410 },
    "Pairing code expired. Generate a new code and try again.",
  ],
  [{ status: 410 }, "Pairing code expired. Generate a new code and try again."],
  [
    { code: "PAIRING_INVALID", status: 401 },
    "The pairing code is invalid. Check the code and try again.",
  ],
  [
    { code: "PAIRING_INSTANCE_MISMATCH", status: 409 },
    "The server instance changed. Refresh the code from the server and try again.",
  ],
  [{ status: 429 }, "Too many attempts. Try again later."],
  [{ status: 500 }, "Pairing failed. Check the code and try again."],
])(
  "rejects a bad or expired code %o without installing a credential",
  async (failure, message) => {
    mocks.pair.mockRejectedValueOnce(failure);
    const retry = deferred<{ token: string }>();
    mocks.pair.mockImplementationOnce(() => retry.promise);
    const { result } = renderHook(() => usePairingState(vi.fn()));
    act(() => result.current.setPairingCodeInput("PAIR-1234"));
    await act(() => result.current.handlePairingSubmit());
    expect(result.current.state.pairingError).toBe(message);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.setToken).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();

    // The next attempt consumes a fresh code and clears the stale error while
    // it is in flight.
    let next!: Promise<void>;
    act(() => {
      next = result.current.handlePairingSubmit();
    });
    expect(result.current.state.pairingError).toBeNull();
    expect(result.current.state.pairingBusy).toBe(true);
    expect(mocks.pair).toHaveBeenCalledTimes(2);
    retry.reject({ status: 500 });
    await act(() => next);
    expect(result.current.state.pairingBusy).toBe(false);
  },
);

it("rejects blank input before calling the pairing API", async () => {
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("   \t "));
  await act(() => result.current.handlePairingSubmit());
  expect(result.current.state.pairingError).toBe(
    "Enter the pairing code from your server.",
  );
  expect(mocks.pair).not.toHaveBeenCalled();
});

it("suppresses a second submit while the first pairing request is in flight", async () => {
  const request = deferred<{ token: string }>();
  mocks.pair.mockImplementation(() => request.promise);
  const { result } = renderHook(() => usePairingState(vi.fn()));
  act(() => result.current.setPairingCodeInput("PAIR-1234"));
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = result.current.handlePairingSubmit();
    second = result.current.handlePairingSubmit();
  });
  expect(mocks.pair).toHaveBeenCalledTimes(1);
  request.reject({ status: 500 });
  await act(() => Promise.all([first, second]));
  expect(result.current.state.pairingBusy).toBe(false);
});

it("drops a pairing reply that arrives after the server connection changed", async () => {
  const request = deferred<{ token: string }>();
  mocks.pair.mockImplementationOnce(() => request.promise);
  const onPaired = vi.fn();
  const { result } = renderHook(() => usePairingState(onPaired));
  act(() => result.current.setPairingCodeInput("OLD-SERVER-CODE"));
  let submission!: Promise<void>;
  act(() => {
    submission = result.current.handlePairingSubmit();
  });
  // The user switches servers while the old server's reply is in flight.
  mocks.getBaseUrl.mockReturnValue("https://other-agent.example.test");
  request.resolve({ token: "stale-session" });
  await act(() => submission);

  expect(mocks.persist).not.toHaveBeenCalled();
  expect(mocks.setToken).not.toHaveBeenCalled();
  expect(onPaired).not.toHaveBeenCalled();
  expect(result.current.state.pairingError).toBe(
    "The server connection changed during pairing. Enter a pairing code from the current server.",
  );

  // The stale credential is not replayed against the new server: a fresh code
  // is required and only the new server's token is installed.
  mocks.resume.mockResolvedValue(undefined);
  mocks.pair.mockResolvedValueOnce({ token: "current-session" });
  act(() => result.current.setPairingCodeInput("NEW-SERVER-CODE"));
  await act(() => result.current.handlePairingSubmit());
  expect(mocks.pair).toHaveBeenLastCalledWith("NEW-SERVER-CODE");
  expect(mocks.persist).toHaveBeenCalledWith(
    "current-session",
    "https://other-agent.example.test",
  );
  expect(mocks.setToken).toHaveBeenCalledTimes(1);
  expect(mocks.setToken).toHaveBeenCalledWith("current-session");
  expect(onPaired).toHaveBeenCalledOnce();
});

it("does not install a token when the server changes while the credential is saved", async () => {
  const persistence = deferred<void>();
  mocks.persist.mockImplementationOnce(() => persistence.promise);
  const onPaired = vi.fn();
  const { result } = renderHook(() => usePairingState(onPaired));
  act(() => result.current.setPairingCodeInput("PAIR-1234"));
  let submission!: Promise<void>;
  act(() => {
    submission = result.current.handlePairingSubmit();
  });
  await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
  mocks.getBaseUrl.mockReturnValue("https://other-agent.example.test");
  persistence.resolve();
  await act(() => submission);
  expect(mocks.setToken).not.toHaveBeenCalled();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(onPaired).not.toHaveBeenCalled();
  expect(result.current.state.pairingError).toContain(
    "server connection changed",
  );
});
