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
  createHandler,
  ensureWorkspace,
  loadConfig,
  type CodingRemoteRunnerCommandRunner,
} from "../src/index";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await mkdtemp(nodePath.join(tmpdir(), "coding-remote-runner-"));
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
  it("requires bearer auth on the remote runner API", async () => {
    const response = await handler()(request("/v1/health", {}, false));

    expect(response.status).toBe(401);
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
    const commandCalls: Array<{ command: string; args: string[]; cwd: string }> =
      [];
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
});
