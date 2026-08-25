// Exercises the coding-remote-runner server path with deterministic cloud service fixtures.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import {
  buildCommandEnv,
  type CodingRemoteRunnerCommandRunner,
  createHandler,
  ensureWorkspace,
  loadConfig,
} from "../src/index";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(
    nodePath.join(tmpdir(), "coding-remote-runner-"),
  );
});

afterEach(() => {
  workspaceRoot = "";
});

function handler(commandRunner?: CodingRemoteRunnerCommandRunner) {
  const config = loadConfig({
    ELIZA_CODING_WORKSPACE: workspaceRoot,
    ELIZA_REMOTE_RUNNER_HTTP_TOKEN: "token",
  });
  return createHandler(config, commandRunner ? { commandRunner } : {});
}

function request(
  path: string,
  init: RequestInit = {},
  authorized = true,
): Request {
  const headers = new Headers(init.headers);
  if (authorized) headers.set("authorization", "Bearer token");
  return new Request(`http://127.0.0.1${path}`, { ...init, headers });
}

describe("coding remote runner HTTP runner", () => {
  it("keeps public liveness free of workspace and auth metadata", async () => {
    const response = await handler()(request("/health", {}, false));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("requires bearer auth on the remote runner API", async () => {
    const response = await handler()(request("/v1/health", {}, false));

    expect(response.status).toBe(401);
  });

  it("rejects wrong and wrong-length bearer tokens, accepts the exact token", async () => {
    const run = handler();
    const withToken = (value: string) =>
      run(
        new Request("http://127.0.0.1/v1/health", {
          headers: { authorization: value },
        }),
      );

    // Wrong value, same length as `Bearer token`.
    expect((await withToken("Bearer xoken")).status).toBe(401);
    // Wrong length (prefix of the expected token).
    expect((await withToken("Bearer toke")).status).toBe(401);
    // Exact match still authorizes (constant-time compare stays correct).
    expect((await withToken("Bearer token")).status).toBe(200);
  });

  it("lists, reads, and writes workspace files", async () => {
    await mkdir(nodePath.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(nodePath.join(workspaceRoot, "README.md"), "hello", "utf8");
    const run = handler();

    const list = await run(request("/v1/fs/entries?path=."));
    const listBody = await list.json();
    expect(list.status).toBe(200);
    expect(
      listBody.entries.map((entry: { name: string }) => entry.name),
    ).toContain("README.md");

    const read = await run(request("/v1/fs/file?path=README.md"));
    expect(await read.text()).toBe("hello");

    const write = await run(
      request("/v1/fs/file?path=src/out.txt", {
        method: "PUT",
        body: "written",
      }),
    );
    expect(write.status).toBe(200);
    expect(
      await readFile(nodePath.join(workspaceRoot, "src/out.txt"), "utf8"),
    ).toBe("written");
  });

  it("rejects paths outside the workspace", async () => {
    const response = await handler()(request("/v1/fs/file?path=/etc/passwd"));

    expect(response.status).toBe(403);
  });

  it("rejects writes through symlinks", async () => {
    const outside = nodePath.join(
      await mkdtemp(nodePath.join(tmpdir(), "coding-remote-runner-outside-")),
      "secret.txt",
    );
    await writeFile(outside, "secret", "utf8");
    await symlink(outside, nodePath.join(workspaceRoot, "link.txt"));

    const response = await handler()(
      request("/v1/fs/file?path=link.txt", {
        method: "PUT",
        body: "overwritten",
      }),
    );

    expect(response.status).toBe(403);
    expect(await readFile(outside, "utf8")).toBe("secret");
  });

  it("runs commands inside the workspace", async () => {
    await ensureWorkspace(
      loadConfig({
        ELIZA_CODING_WORKSPACE: workspaceRoot,
        ELIZA_REMOTE_RUNNER_HTTP_TOKEN: "token",
      }),
    );
    const commandCalls: Array<{
      command: string;
      args: string[];
      cwd: string;
    }> = [];
    const workspaceRealPath = await realpath(workspaceRoot);
    const response = await handler(async (payload) => {
      commandCalls.push({
        command: payload.command,
        args: payload.args,
        cwd: payload.cwd,
      });
      return {
        stdout: `${payload.cwd}\n:ok`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    })(
      request("/v1/processes/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "/bin/pwd",
          args: [],
          cwd: ".",
          timeoutMs: 5000,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ exitCode: 0 });
    expect(commandCalls).toEqual([
      { command: "/bin/pwd", args: [], cwd: workspaceRealPath },
    ]);
    expect(body.stdout).toContain(workspaceRealPath);
    expect(body.stdout).toContain(":ok");
  });

  it("does not inherit runner secrets into spawned commands", () => {
    const config = loadConfig({
      ELIZA_CODING_WORKSPACE: workspaceRoot,
      ELIZA_REMOTE_RUNNER_HTTP_TOKEN: "token",
    });
    const previousRunnerToken = process.env.ELIZA_REMOTE_RUNNER_HTTP_TOKEN;
    const previousSecretCloudKey = process.env.SECRET_CLOUD_KEY;
    const previousPath = process.env.PATH;
    process.env.ELIZA_REMOTE_RUNNER_HTTP_TOKEN = "super-secret-token";
    process.env.SECRET_CLOUD_KEY = "leak-me";
    process.env.PATH = process.env.PATH ?? "/usr/bin";
    try {
      const built = buildCommandEnv({ CALLER_VAR: "ok" }, config);
      // Caller-supplied vars pass through; PATH (allowlisted) is available;
      // runner secrets and arbitrary host vars are withheld.
      expect(built.CALLER_VAR).toBe("ok");
      expect(built.PATH).toBeDefined();
      expect(built.ELIZA_REMOTE_RUNNER_HTTP_TOKEN).toBeUndefined();
      expect(built.SECRET_CLOUD_KEY).toBeUndefined();
    } finally {
      if (previousRunnerToken === undefined) {
        delete process.env.ELIZA_REMOTE_RUNNER_HTTP_TOKEN;
      } else {
        process.env.ELIZA_REMOTE_RUNNER_HTTP_TOKEN = previousRunnerToken;
      }
      if (previousSecretCloudKey === undefined) {
        delete process.env.SECRET_CLOUD_KEY;
      } else {
        process.env.SECRET_CLOUD_KEY = previousSecretCloudKey;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("drops a caller-supplied runner token from the command env", () => {
    const config = loadConfig({
      ELIZA_CODING_WORKSPACE: workspaceRoot,
      ELIZA_REMOTE_RUNNER_HTTP_TOKEN: "token",
    });
    const built = buildCommandEnv(
      { ELIZA_REMOTE_RUNNER_HTTP_TOKEN: "stolen", KEEP: "yes" },
      config,
    );
    expect(built.ELIZA_REMOTE_RUNNER_HTTP_TOKEN).toBeUndefined();
    expect(built.KEEP).toBe("yes");
  });

  it("never forwards the runner token even if allowlisted", async () => {
    const config = loadConfig({
      ELIZA_CODING_WORKSPACE: workspaceRoot,
      ELIZA_REMOTE_RUNNER_HTTP_TOKEN: "token",
      ELIZA_REMOTE_RUNNER_ENV_ALLOWLIST:
        "ELIZA_REMOTE_RUNNER_HTTP_TOKEN,REMOTE_RUNNER_HTTP_TOKEN",
    });
    // The denylist should have stripped the secrets from the allowlist.
    expect(config.commandEnvAllowlist).not.toContain(
      "ELIZA_REMOTE_RUNNER_HTTP_TOKEN",
    );
    expect(config.commandEnvAllowlist).not.toContain(
      "REMOTE_RUNNER_HTTP_TOKEN",
    );
  });

  it("blocks command execution when unauthenticated even with the escape hatch on", async () => {
    const config = loadConfig({
      ELIZA_CODING_WORKSPACE: workspaceRoot,
      ELIZA_REMOTE_RUNNER_ALLOW_UNAUTHENTICATED: "1",
    });
    let ran = false;
    const run = createHandler(config, {
      commandRunner: async () => {
        ran = true;
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
    });
    const response = await run(
      request(
        "/v1/processes/run",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "/bin/true", timeoutMs: 5000 }),
        },
        false,
      ),
    );
    expect(response.status).toBe(503);
    expect(ran).toBe(false);
  });

  it("logs but does not return unexpected command-runner exception text", async () => {
    const marker = "<script>secret /workspace/private.ts:17</script>";
    const run = handler(async () => {
      const error = new Error(marker);
      error.stack = `Error: ${marker}\n    at /workspace/private.ts:17:3`;
      throw error;
    });

    const response = await run(
      request("/v1/processes/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/bin/true", timeoutMs: 5000 }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "remote runner request failed",
    });
  });

  it("survives a thrown proxy whose prototype and properties are hostile", async () => {
    const hostile = new Proxy(Object.create(null), {
      getPrototypeOf() {
        throw new Error("prototype secret");
      },
      get() {
        throw new Error("getter secret");
      },
    });
    const run = handler(async () => {
      throw hostile;
    });

    const response = await run(
      request("/v1/processes/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/bin/true", timeoutMs: 5000 }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "remote runner request failed",
    });
  });

  it("does not reflect an attacker-controlled environment key in a 400", async () => {
    const marker = `${"x".repeat(8_192)}\u202e<script>`;
    const run = handler(async () => {
      throw new Error("command runner must not run");
    });
    const response = await run(
      request("/v1/processes/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          command: "/bin/true",
          env: { [marker]: false },
        }),
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("env entries must be strings");
    expect(body).not.toContain(marker);
    expect(body.length).toBeLessThan(256);
  });

  it("blocks unauthenticated workspace writes even with the escape hatch on", async () => {
    const config = loadConfig({
      ELIZA_CODING_WORKSPACE: workspaceRoot,
      ELIZA_REMOTE_RUNNER_ALLOW_UNAUTHENTICATED: "1",
    });
    const response = await createHandler(config)(
      request(
        "/v1/fs/file?path=escape.txt",
        { method: "PUT", body: "nope" },
        false,
      ),
    );
    expect(response.status).toBe(503);
  });

  it("still allows unauthenticated read-only routes under the escape hatch", async () => {
    await writeFile(nodePath.join(workspaceRoot, "pub.txt"), "pub", "utf8");
    const config = loadConfig({
      ELIZA_CODING_WORKSPACE: workspaceRoot,
      ELIZA_REMOTE_RUNNER_ALLOW_UNAUTHENTICATED: "1",
    });
    const run = createHandler(config);
    const health = await run(request("/v1/health", {}, false));
    expect(health.status).toBe(200);
    const read = await run(request("/v1/fs/file?path=pub.txt", {}, false));
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("pub");
  });

  it("defaults to a loopback bind address", () => {
    const config = loadConfig({ ELIZA_CODING_WORKSPACE: workspaceRoot });
    expect(config.hostname).toBe("127.0.0.1");
    const explicit = loadConfig({
      ELIZA_CODING_WORKSPACE: workspaceRoot,
      HOST: "0.0.0.0",
    });
    expect(explicit.hostname).toBe("0.0.0.0");
  });
});
