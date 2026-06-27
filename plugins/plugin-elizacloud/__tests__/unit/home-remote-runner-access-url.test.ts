import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHomeRemoteRunnerAccessUrl,
  buildHomeRemoteRunnerSshTunnel,
  HOME_REMOTE_RUNNER_ACCESS_SESSION_PARAM,
} from "../../src/routes/home-remote-runner-access-url";

describe("buildHomeRemoteRunnerAccessUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the default Eliza Cloud home instance URL", () => {
    const url = buildHomeRemoteRunnerAccessUrl({ sessionId: "session-123" });

    expect(url).toBe(
      `https://elizacloud.ai/dashboard/app?${HOME_REMOTE_RUNNER_ACCESS_SESSION_PARAM}=session-123`
    );
  });

  it("normalizes legacy API bases into the public cloud URL shape", () => {
    const url = buildHomeRemoteRunnerAccessUrl({
      cloudBaseUrl: "https://api.elizacloud.ai/api/v1",
      sessionId: "session-123",
    });

    expect(url).toBe(
      `https://elizacloud.ai/dashboard/app?${HOME_REMOTE_RUNNER_ACCESS_SESSION_PARAM}=session-123`
    );
  });

  it("preserves local cloud dev origins", () => {
    const url = buildHomeRemoteRunnerAccessUrl({
      cloudBaseUrl: "http://127.0.0.1:8787/api/v1",
      sessionId: "local-session",
    });

    expect(url).toBe(
      `http://127.0.0.1:8787/dashboard/app?${HOME_REMOTE_RUNNER_ACCESS_SESSION_PARAM}=local-session`
    );
  });

  it("returns null without a relay session", () => {
    expect(buildHomeRemoteRunnerAccessUrl({ sessionId: "" })).toBeNull();
    expect(buildHomeRemoteRunnerAccessUrl({ sessionId: null })).toBeNull();
  });
});

describe("buildHomeRemoteRunnerSshTunnel", () => {
  it("builds an SSH local-forward command for a home Remote", () => {
    const tunnel = buildHomeRemoteRunnerSshTunnel({
      remoteBaseUrl: "http://127.0.0.1:2468",
      sshTarget: "user@home.local",
    });

    expect(tunnel).toEqual({
      command: "ssh -N -L 127.0.0.1:2468:127.0.0.1:2468 user@home.local",
      localUrl: "http://127.0.0.1:2468",
    });
  });

  it("supports an identity file and local port override", () => {
    const tunnel = buildHomeRemoteRunnerSshTunnel({
      remoteBaseUrl: "http://home.internal:8080",
      sshTarget: "user@home.internal",
      sshIdentity: "/Users/me/.ssh/eliza home",
      localPort: 32_468,
    });

    expect(tunnel).toEqual({
      command:
        "ssh -N -i '/Users/me/.ssh/eliza home' -L 127.0.0.1:32468:home.internal:8080 user@home.internal",
      localUrl: "http://127.0.0.1:32468",
    });
  });

  it("rejects missing or unsafe SSH tunnel settings", () => {
    expect(
      buildHomeRemoteRunnerSshTunnel({
        remoteBaseUrl: "http://127.0.0.1:2468",
        sshTarget: "",
      })
    ).toBeNull();
    expect(
      buildHomeRemoteRunnerSshTunnel({
        remoteBaseUrl: "not a url",
        sshTarget: "user@home.local",
      })
    ).toBeNull();
    expect(
      buildHomeRemoteRunnerSshTunnel({
        remoteBaseUrl: "http://127.0.0.1:2468",
        sshTarget: "user@home.local -oProxyCommand=bad",
      })
    ).toBeNull();
    expect(
      buildHomeRemoteRunnerSshTunnel({
        remoteBaseUrl: "http://127.0.0.1:2468",
        sshTarget: "user@home.local;bad",
      })
    ).toBeNull();
    expect(
      buildHomeRemoteRunnerSshTunnel({
        remoteBaseUrl: "https://home.internal:8443",
        sshTarget: "user@home.local",
      })
    ).toBeNull();
  });
});
