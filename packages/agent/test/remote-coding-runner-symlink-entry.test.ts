/**
 * A symlink in a remote coding workspace must keep its kind through fs.list.
 * The coding remote runner reports it as `type: "symlink"` without a target,
 * and the router has to list it as a symlink, as the local listing does.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCharacter } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import {
  createHandler as createRunnerHandler,
  loadConfig as loadRunnerConfig,
} from "../../cloud/services/coding-remote-runner/src/index.ts";
import { RemoteCodingCapabilityRouterService } from "../src/services/remote-coding-runner.ts";

it("lists a symlink in the remote workspace with kind symlink", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "remote-runner-link-"));
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "RemoteRunnerLink" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  try {
    await writeFile(path.join(workspace, "AGENTS.md"), "rules\n");
    await mkdir(path.join(workspace, "src"));
    await symlink("AGENTS.md", path.join(workspace, "CLAUDE.md"));

    // Serve the real runner handler in process for the runner's host only.
    const runnerHandler = createRunnerHandler(
      loadRunnerConfig({
        ELIZA_CODING_WORKSPACE: workspace,
        ELIZA_REMOTE_RUNNER_HTTP_TOKEN: "runner-token",
      }),
    );
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).host !== "runner.test") {
          throw new Error(`Unexpected fetch to ${request.url}`);
        }
        return runnerHandler(request);
      },
    );

    const router = new RemoteCodingCapabilityRouterService(runtime, {
      enabled: true,
      provider: "home",
      remoteHttpBaseUrl: "http://runner.test",
      remoteHttpToken: "runner-token",
      agentRunners: [],
      workdir: "/workspace",
      hostWorkspaceRoot: workspace,
      timeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      keepAlive: true,
      allowInternetAccess: false,
      envs: {},
      metadata: {},
    });

    const result = await router.fs.list({
      path: "/workspace",
      includeHidden: true,
    });

    expect(
      Object.fromEntries(
        result.entries.map((entry) => [entry.name, entry.kind]),
      ),
    ).toEqual({
      "AGENTS.md": "file",
      "CLAUDE.md": "symlink",
      src: "directory",
    });
  } finally {
    vi.unstubAllGlobals();
    await runtime.close?.();
    await rm(workspace, { recursive: true, force: true });
  }
});
