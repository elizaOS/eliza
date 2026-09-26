import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingRemoteFirstRun,
  completeRemoteAgentFirstRun,
  type RemoteFirstRunClient,
  resumeRemoteFirstRunAfterPairing,
} from "./adopt-remote-first-run";

vi.mock("./first-run-pending-text", () => ({
  releasePendingFirstRunText: vi.fn(),
}));

const base = "http://10.0.2.2:31338";
function fixture() {
  let authenticated = false;
  let complete = false;
  const client: RemoteFirstRunClient = {
    getFirstRunStatus: vi.fn(async () => ({ complete })),
    getStatus: vi.fn(async () => ({ state: "running", canRespond: true })),
    updateConfig: vi.fn(async () => {
      if (!authenticated)
        throw Object.assign(new Error("Unauthorized"), { status: 401 });
      complete = true;
      return {};
    }),
  };
  return {
    client,
    authenticate: () => {
      authenticated = true;
    },
  };
}

beforeEach(clearPendingRemoteFirstRun);

describe("remote first-run continuation after pairing", () => {
  it("adopts a configured host without rewriting its configuration", async () => {
    const { client } = fixture();
    vi.mocked(client.getFirstRunStatus).mockResolvedValue({ complete: true });
    const complete = vi.fn();
    await completeRemoteAgentFirstRun(client, { apiBase: base }, complete);
    expect(client.updateConfig).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    await resumeRemoteFirstRunAfterPairing(client, base);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("never declares completion when the authenticated host rejects the setup write", async () => {
    const { client } = fixture();
    const complete = vi.fn();
    await expect(
      completeRemoteAgentFirstRun(client, { apiBase: base }, complete),
    ).rejects.toMatchObject({ status: 401 });
    vi.mocked(client.updateConfig).mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    await expect(
      resumeRemoteFirstRunAfterPairing(client, base),
    ).rejects.toMatchObject({ status: 403 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("finishes the approved adoption before startup resumes and consumes it once", async () => {
    const { client, authenticate } = fixture();
    const complete = vi.fn();
    await expect(
      completeRemoteAgentFirstRun(client, { apiBase: base }, complete),
    ).rejects.toMatchObject({ status: 401 });
    expect(complete).not.toHaveBeenCalled();
    authenticate();
    await resumeRemoteFirstRunAfterPairing(client, `${base}/`);
    expect(client.updateConfig).toHaveBeenLastCalledWith({
      meta: { firstRunComplete: true },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    await resumeRemoteFirstRunAfterPairing(client, base);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not apply one server's setup intent to another paired server", async () => {
    const { client, authenticate } = fixture();
    const complete = vi.fn();
    await expect(
      completeRemoteAgentFirstRun(client, { apiBase: base }, complete),
    ).rejects.toThrow();
    authenticate();
    await resumeRemoteFirstRunAfterPairing(client, "http://10.0.2.2:31339");
    await resumeRemoteFirstRunAfterPairing(client, base);
    expect(client.updateConfig).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("discards an adoption superseded by another approved connection", async () => {
    const { client, authenticate } = fixture();
    const complete = vi.fn();
    await expect(
      completeRemoteAgentFirstRun(client, { apiBase: base }, complete),
    ).rejects.toThrow();
    clearPendingRemoteFirstRun();
    authenticate();
    await resumeRemoteFirstRunAfterPairing(client, base);
    expect(complete).not.toHaveBeenCalled();
    expect(client.updateConfig).toHaveBeenCalledTimes(1);
  });

  it("does not turn a host readiness failure into a pairing continuation", async () => {
    const { client } = fixture();
    vi.mocked(client.getStatus).mockResolvedValue({
      state: "stopped",
      canRespond: false,
    });
    const complete = vi.fn();
    await expect(
      completeRemoteAgentFirstRun(client, { apiBase: base }, complete),
    ).rejects.toThrow("Start and configure");
    vi.mocked(client.getStatus).mockResolvedValue({
      state: "running",
      canRespond: true,
    });
    await resumeRemoteFirstRunAfterPairing(client, base);
    expect(client.updateConfig).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("retries a failed authenticated adoption instead of silently dropping it", async () => {
    const { client, authenticate } = fixture();
    const complete = vi.fn();
    await expect(
      completeRemoteAgentFirstRun(client, { apiBase: base }, complete),
    ).rejects.toMatchObject({ status: 401 });
    authenticate();
    vi.mocked(client.updateConfig).mockRejectedValueOnce(
      Object.assign(new Error("Temporarily unavailable"), { status: 503 }),
    );
    await expect(
      resumeRemoteFirstRunAfterPairing(client, base),
    ).rejects.toThrow("Temporarily unavailable");
    expect(complete).not.toHaveBeenCalled();
    await resumeRemoteFirstRunAfterPairing(client, base);
    expect(client.updateConfig).toHaveBeenCalledTimes(3);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("does not complete local setup after a pending adoption was superseded", async () => {
    const { client } = fixture();
    let resolveStatus!: (status: { complete: boolean }) => void;
    vi.mocked(client.getFirstRunStatus).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const complete = vi.fn();
    const adoption = completeRemoteAgentFirstRun(
      client,
      { apiBase: base },
      complete,
    );
    clearPendingRemoteFirstRun();
    resolveStatus({ complete: true });
    await expect(adoption).rejects.toMatchObject({
      code: "REMOTE_ADOPTION_SUPERSEDED",
    });
    expect(complete).not.toHaveBeenCalled();
  });
});
