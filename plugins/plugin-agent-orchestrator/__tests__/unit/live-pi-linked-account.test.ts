/** Exercises live-harness admission and owned child cleanup with real keyless subprocesses; no provider is contacted. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  runOwnedChild,
  safeResponseOutcome,
} from "../../scripts/live-pi-linked-account.mjs";

const script = fileURLToPath(
  new URL("../../scripts/live-pi-linked-account.mjs", import.meta.url),
);
test("selected live check fails when its credential is absent and emits no success receipt", () => {
  const result = spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH, RUN_LIVE_PI_LINKED_ACCOUNT: "1" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /failed during admission/);
});
test("live credentials alone do not arm a provider request", () => {
  const result = spawnSync(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      OPENROUTER_API_KEY: "synthetic-not-a-provider-key",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.ok(!result.stderr.includes("synthetic-not-a-provider-key"));
});
test.skipIf(process.platform === "win32")(
  "owned child records completion and exits naturally",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pi-parent-test-"));
    try {
      const file = path.join(dir, "complete");
      const result = await runOwnedChild(
        process.execPath,
        [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], "done")',
          file,
        ],
        { env: { PATH: process.env.PATH } },
        5_000,
      );
      assert.equal(result.code, 0);
      assert.equal(await readFile(file, "utf8"), "done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test.skipIf(process.platform === "win32")(
  "owned deadline kills a signal-resistant child and rejects instead of hanging",
  async () => {
    const start = Date.now();
    await assert.rejects(
      runOwnedChild(
        process.execPath,
        ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
        { env: { PATH: process.env.PATH } },
        200,
      ),
      /owned-process deadline/,
    );
    assert.ok(Date.now() - start < 6_000);
  },
);

test("internal child cannot write to a profile without parent authorization", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-child-guard-"));
  try {
    const result = spawnSync(process.execPath, [script, "--child"], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        ELIZA_HOME: root,
        RUN_LIVE_PI_LINKED_ACCOUNT: "1",
        OPENROUTER_API_KEY: "synthetic-not-a-provider-key",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    await assert.rejects(readFile(path.join(root, "failure.json")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path.join(root, "receipt.json")), {
      code: "ENOENT",
    });
    assert.ok(!result.stderr.includes("synthetic-not-a-provider-key"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed admission writes only a sanitized failure receipt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-failure-receipt-"));
  try {
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        RUN_LIVE_PI_LINKED_ACCOUNT: "1",
        LIVE_PI_EVIDENCE_DIR: root,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    const receipt = JSON.parse(
      await readFile(path.join(root, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.phase, "admission-credential");
    assert.ok(!JSON.stringify(receipt).includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "parent kills retained descendants and rejects incomplete natural cleanup",
  async () => {
    await assert.rejects(
      runOwnedChild(
        process.execPath,
        [
          "-e",
          `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.unref();`,
        ],
        { env: { PATH: process.env.PATH } },
        5_000,
      ),
      /retained descendants/,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "parent cancellation terminates the owned child group",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-signal-parent-"));
    const pidFile = path.join(root, "child.pid");
    const helperUrl = new URL(
      "../../scripts/live-pi-linked-account.mjs",
      import.meta.url,
    ).href;
    const childCode = `require("node:fs").writeFileSync(process.argv[1],String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);`;
    const parentCode = `import {runOwnedChild} from ${JSON.stringify(helperUrl)}; try { await runOwnedChild(process.execPath,["-e",${JSON.stringify(childCode)},${JSON.stringify(pidFile)}],{env:{PATH:process.env.PATH}},10000); } catch {process.exitCode=1;}`;
    const parent = spawn(
      process.execPath,
      ["--input-type=module", "-e", parentCode],
      { env: { PATH: process.env.PATH }, stdio: "ignore" },
    );
    const exited = new Promise((resolve, reject) => {
      parent.once("exit", resolve);
      parent.once("error", reject);
    });
    let childPid: number | undefined;
    try {
      const until = Date.now() + 5000;
      while (!childPid && Date.now() < until) {
        try {
          childPid = Number(await readFile(pidFile, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(childPid);
      parent.kill("SIGTERM");
      await exited;
      assert.equal(parent.exitCode, 1);
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    } finally {
      parent.kill("SIGKILL");
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          assert.ok(
            error instanceof Error && "code" in error && error.code === "ESRCH",
          );
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);

test("wrong reviewed source retains the source-admission phase without exposing credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-source-admission-"));
  const syntheticCredential = "synthetic-not-a-provider-key";
  try {
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        RUN_LIVE_PI_LINKED_ACCOUNT: "1",
        OPENROUTER_API_KEY: syntheticCredential,
        LIVE_PI_SOURCE_SHA: "0".repeat(40),
        LIVE_PI_EVIDENCE_DIR: root,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    const serialized = await readFile(path.join(root, "receipt.json"), "utf8");
    assert.equal(JSON.parse(serialized).phase, "admission-source");
    assert.ok(!serialized.includes(syntheticCredential));
    assert.ok(!result.stderr.includes(syntheticCredential));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "an authorized child reports its real missing dependency import without provider execution",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-import-admission-"));
    try {
      await chmod(root, 0o700);
      const copiedScript = path.join(root, "harness.mjs");
      await copyFile(script, copiedScript);
      const authorization = "a".repeat(64);
      await writeFile(path.join(root, ".child-authorization"), authorization, {
        mode: 0o600,
      });
      const result = spawnSync(process.execPath, [copiedScript, "--child"], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          ELIZA_HOME: root,
          RUN_LIVE_PI_LINKED_ACCOUNT: "1",
          OPENROUTER_API_KEY: "synthetic-not-a-provider-key",
          LIVE_PI_CHILD_AUTHORIZATION: authorization,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      assert.equal(
        JSON.parse(await readFile(path.join(root, "failure.json"), "utf8"))
          .phase,
        "import-account-storage",
      );
      await assert.rejects(readFile(path.join(root, "receipt.json")), {
        code: "ENOENT",
      });
      assert.ok(!result.stderr.includes("synthetic-not-a-provider-key"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(
  process.platform === "win32"
    ? ["generated cache.txt"]
    : ["generated cache.txt", "generated\ncache.txt"],
)(
  "dirty source is rejected with safe status metadata: %j",
  async (filename) => {
    const container = await mkdtemp(path.join(tmpdir(), "pi-dirty-checkout-"));
    const repo = path.join(container, "repo");
    const evidence = path.join(container, "evidence");
    const copiedScript = path.join(
      repo,
      "plugins/plugin-agent-orchestrator/scripts/live-pi-linked-account.mjs",
    );
    try {
      await mkdir(path.dirname(copiedScript), { recursive: true });
      await copyFile(script, copiedScript);
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      git(["init"]);
      git(["add", "."]);
      git([
        "-c",
        "user.name=Disposable QA",
        "-c",
        "user.email=qa@example.invalid",
        "commit",
        "-m",
        "fixture",
      ]);
      const head = git(["rev-parse", "HEAD"]).trim();
      const contents = "synthetic-private-content-never-in-receipt";
      await writeFile(path.join(repo, filename), contents);
      const result = spawnSync(process.execPath, [copiedScript], {
        env: {
          PATH: process.env.PATH,
          RUN_LIVE_PI_LINKED_ACCOUNT: "1",
          OPENROUTER_API_KEY: "synthetic-not-a-provider-key",
          LIVE_PI_SOURCE_SHA: head,
          LIVE_PI_TOOL_VERSIONS: JSON.stringify({
            pi: "0.84.2",
            piAcp: "0.0.33",
            piAi: "0.84.4",
          }),
          LIVE_PI_EVIDENCE_DIR: evidence,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 1);
      const serialized = await readFile(
        path.join(evidence, "receipt.json"),
        "utf8",
      );
      const receipt = JSON.parse(serialized);
      assert.equal(receipt.phase, "admission-clean-checkout");
      if (filename.includes("\n"))
        assert.equal(receipt.checkoutChanges, undefined);
      else
        assert.deepEqual(receipt.checkoutChanges, [
          { status: "??", path: filename },
        ]);
      assert.ok(!serialized.includes(contents));
      assert.ok(!serialized.includes(container));
      assert.ok(!serialized.includes("synthetic-not-a-provider-key"));
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  "real ACP rejection keeps structured status and excludes sensitive response text (%s)",
  async (sensitiveResponse) => {
    const { NativeAcpClient } = await import(
      "../../src/services/acp-native-transport"
    );
    const root = await mkdtemp(path.join(tmpdir(), "pi-outcome-wire-"));
    const credential = "synthetic-not-a-provider-key";
    const response = sensitiveResponse
      ? `untrusted response ${credential}`
      : "Complete benign response 🌿\nsecond line";
    const fixture = path.join(root, "provider.mjs");
    await writeFile(
      fixture,
      String.raw`import readline from 'node:readline';
    for await (const line of readline.createInterface({input:process.stdin})) {
      const request=JSON.parse(line); if(!request.id) continue;
      if(request.method==='session/prompt') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'qa',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(response)}}}}})+'\n');
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:${JSON.stringify(credential)},data:{status:402,privatePath:${JSON.stringify(root)}}}})+'\n');
      } else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='initialize'?{protocolVersion:1,agentCapabilities:{}}:{sessionId:'qa',models:{currentModelId:'openrouter/openai/gpt-4.1-mini'}}})+'\n');
    }`,
    );
    let actualResponse = "";
    let actualPrompt: unknown;
    let rejection: unknown;
    const client = new NativeAcpClient({
      command: `${process.execPath} ${fixture}`,
      cwd: root,
      approvalPreset: "readonly",
      timeoutMs: 5000,
      expectedModelId: "openrouter/openai/gpt-4.1-mini",
      env: { PATH: process.env.PATH },
      onEvent(event) {
        if (event.method === "session/prompt")
          actualPrompt = event.params.prompt;
        const update = event.params?.update;
        if (update?.sessionUpdate === "agent_message_chunk")
          actualResponse += update.content.text;
      },
    });
    try {
      try {
        await client.start();
        const session = await client.createSession();
        await assert.rejects(async () => {
          try {
            await client.prompt(
              session.sessionId,
              "Complete response-only prompt",
            );
          } catch (error) {
            rejection = error;
            throw error;
          }
        });
      } finally {
        await client.close();
      }
      const outcome = safeResponseOutcome({
        result: undefined,
        response: actualResponse,
        sentPrompt: actualPrompt,
        expectedPrompt: "Complete response-only prompt",
        expectedResponse: "expected",
        promptResolved: false,
        modelConfirmed: true,
        toolCall: false,
        nativeCleanupClosed: true,
        error: rejection,
        credential,
        privateRoots: [root],
      });
      assert.deepEqual(outcome.transportError, {
        name: "AcpRequestError",
        httpStatus: 402,
        jsonRpcCode: -32000,
      });
      assert.equal(outcome.promptResolved, false);
      assert.equal(outcome.promptBytesMatch, true);
      assert.equal(outcome.nativeCleanupClosed, true);
      assert.equal(outcome.responseBytes, Buffer.byteLength(response));
      if (sensitiveResponse) {
        assert.equal(outcome.response, undefined);
        assert.equal(
          outcome.responseOmittedReason,
          "credential-or-private-path",
        );
      } else assert.equal(outcome.response, response);
      const serialized = JSON.stringify(outcome);
      assert.ok(!serialized.includes(credential));
      assert.ok(!serialized.includes(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
