// Error-policy proofs for the registry helpers (#13415): a failed cloud/SSH
// call must surface (typed throw or logged warn) and stay distinguishable from
// a legitimately-empty result. Deterministic fixtures — the SSH client is a
// mock, the logger is spied; no live Docker/Hetzner.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { containersEnv as actualContainersEnv } from "../../../config/containers-env";
import { logger } from "../../../utils/logger";
import { HetznerClientError } from "./types";

const registryUsername = mock(() => undefined as string | undefined);
const registryToken = mock(() => undefined as string | undefined);
const registryTokenFile = mock(() => undefined as string | undefined);

// Override only the registry-credential accessors; spread the rest so no other
// containersEnv method becomes undefined for files importing after this one.
mock.module("../../../config/containers-env", () => ({
  containersEnv: {
    ...actualContainersEnv,
    registryUsername,
    registryToken,
    registryTokenFile,
  },
}));

const { readPulledImageDigest, loginToImageRegistry } = await import("./registry");

function sshReturning(output: string) {
  return { exec: mock(async () => output) };
}
function sshThrowing(message: string) {
  return {
    exec: mock(async () => {
      throw new Error(message);
    }),
  };
}

describe("readPulledImageDigest — failure vs designed-empty", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("returns the sha256 digest from a well-formed RepoDigests array", async () => {
    const ssh = sshReturning('["ghcr.io/elizaos/eliza@sha256:abc123"]');
    const digest = await readPulledImageDigest(ssh as never, "ghcr.io/elizaos/eliza:stable");
    expect(digest).toBe("ghcr.io/elizaos/eliza@sha256:abc123");
    // A clean success must not warn.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("designed-empty (docker prints 'null') returns undefined WITHOUT a warn", async () => {
    const ssh = sshReturning("null");
    const digest = await readPulledImageDigest(ssh as never, "ghcr.io/elizaos/eliza:stable");
    expect(digest).toBeUndefined();
    // Legitimately-empty result stays distinct from an internal failure: silent.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("empty RepoDigests array returns undefined WITHOUT a warn", async () => {
    const ssh = sshReturning("[]");
    const digest = await readPulledImageDigest(ssh as never, "ghcr.io/elizaos/eliza:stable");
    expect(digest).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("SSH/transport failure surfaces as a warn (not silently swallowed) and yields undefined", async () => {
    const ssh = sshThrowing("ssh connection reset");
    const digest = await readPulledImageDigest(ssh as never, "ghcr.io/elizaos/eliza:stable");
    expect(digest).toBeUndefined();
    // The internal failure must be observable — the pre-fix `.catch(() => "")`
    // made it indistinguishable from a digest-less image.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg, ctx] = warnSpy.mock.calls[0] as [string, { error: string }];
    expect(msg).toContain("docker image inspect failed");
    expect(ctx.error).toContain("ssh connection reset");
  });

  test("malformed (non-JSON) inspect output surfaces as a warn and yields undefined", async () => {
    const ssh = sshReturning("not-json-at-all {");
    const digest = await readPulledImageDigest(ssh as never, "ghcr.io/elizaos/eliza:stable");
    expect(digest).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect((warnSpy.mock.calls[0] as [string])[0]).toContain("unparseable RepoDigests");
  });
});

describe("loginToImageRegistry — token-file failure fails closed (typed throw)", () => {
  beforeEach(() => {
    for (const m of [registryUsername, registryToken, registryTokenFile]) {
      m.mockReset();
      m.mockReturnValue(undefined);
    }
  });

  test("unreadable configured token file throws a typed HetznerClientError (with cause), never anonymous fallback", async () => {
    registryUsername.mockReturnValue("robot");
    registryTokenFile.mockReturnValue("/nonexistent/path/registry-token.does-not-exist");
    const ssh = sshReturning("");

    let thrown: unknown;
    try {
      await loginToImageRegistry(ssh as never, "ghcr.io/elizaos/eliza:stable");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HetznerClientError);
    const err = thrown as HetznerClientError;
    expect(err.code).toBe("invalid_input");
    // cause is threaded through so the underlying fs error is not lost.
    expect(err.cause).toBeInstanceOf(Error);
    // A configured-but-broken credential must NOT silently degrade to an
    // anonymous pull: the exec (docker login) never runs.
    expect(ssh.exec).not.toHaveBeenCalled();
  });

  test("no credentials configured is a designed anonymous-skip (no throw, no exec) — distinct from failure", async () => {
    const ssh = sshReturning("");
    await expect(
      loginToImageRegistry(ssh as never, "ghcr.io/elizaos/eliza:stable"),
    ).resolves.toBeUndefined();
    expect(ssh.exec).not.toHaveBeenCalled();
  });
});
