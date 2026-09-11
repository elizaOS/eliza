#!/usr/bin/env bun
/**
 * Qualifies a linked OpenRouter account through encrypted storage, the production
 * selector, provider routing, and real Pi ACP inference. The parent owns a
 * private disposable profile and process group; only a sanitized receipt leaves
 * it. Missing credentials and incomplete cleanup fail the explicitly selected run.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), "../../..");
const model = "openai/gpt-4.1-mini";
const marker = "ELIZA_PI_LINKED_ACCOUNT_OK";
const prompt = `This is a response-only integration check. Do not call any tools, read files, execute commands, change state, or contact any service. Reply with exactly ${marker} and no other text.`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
let phase = "admission";
let childAdmitted = false;
const phases = new Set([
  "admission",
  "admission-opt-in",
  "admission-credential",
  "admission-source",
  "admission-tool-versions",
  "admission-clean-checkout",
  "admission-platform",
  "child-ownership",
  "import-account-storage",
  "import-account-pool",
  "import-core",
  "import-provider-route",
  "import-native-client",

  "encrypted-account-storage",
  "linked-account-selection",
  "pi-provider-route",
  "pi-acp-initialize",
  "pi-selected-model-admission",
  "live-provider-response",
  "native-client-cleanup",
  "owned-process-cleanup",
  "child-execution",
]);
const sourcePaths = [
  "packages/app-core/src/services/account-pool.ts",
  "packages/app-core/src/services/coding-account-bridge.ts",
  "packages/auth/src/account-storage.ts",
  "plugins/plugin-agent-orchestrator/src/services/pi-provider-config.ts",
  "plugins/plugin-agent-orchestrator/src/services/acp-native-transport.ts",
  "plugins/plugin-agent-orchestrator/scripts/live-pi-linked-account.mjs",
];

async function child() {
  phase = "child-ownership";
  assert.equal(process.env.RUN_LIVE_PI_LINKED_ACCOUNT, "1");
  const credential = process.env.OPENROUTER_API_KEY;
  assert.ok(credential?.trim(), "Selected live Pi check requires a credential");
  const root = process.env.ELIZA_HOME;
  assert.ok(root && root === process.env.HOME);
  const ownership = await lstat(root);
  assert.ok(ownership.isDirectory() && !ownership.isSymbolicLink());
  assert.equal(ownership.mode & 0o777, 0o700);
  assert.equal(ownership.uid, process.getuid());
  assert.match(process.env.LIVE_PI_CHILD_AUTHORIZATION || "", /^[a-f0-9]{64}$/);
  const authorizationPath = path.join(root, ".child-authorization");
  assert.equal(
    await readFile(authorizationPath, "utf8"),
    process.env.LIVE_PI_CHILD_AUTHORIZATION,
  );
  await unlink(authorizationPath);
  childAdmitted = true;
  const workdir = path.join(root, "workspace");
  await mkdir(workdir, { mode: 0o700 });
  phase = "import-account-storage";
  const { createRuntimeAccountStoragePolicy, saveAccount, loadAccount } =
    await import("@elizaos/auth/account-storage");
  phase = "import-account-pool";
  const { getDefaultAccountPool } = await import(
    "../../../packages/app-core/src/services/account-pool.ts"
  );
  phase = "import-core";
  const { getCodingAgentSelectorBridge } = await import("@elizaos/core");
  phase = "import-provider-route";
  const { preparePiProviderRoute, enforcePiProviderCredentialIsolation } =
    await import("../src/services/pi-provider-config.ts");
  phase = "import-native-client";
  const { NativeAcpClient } = await import(
    "../src/services/acp-native-transport.ts"
  );
  phase = "encrypted-account-storage";
  const policy = createRuntimeAccountStoragePolicy(root);
  const now = Date.now();
  saveAccount(
    {
      id: "live-proof",
      providerId: "openrouter-api",
      label: "Disposable live proof",
      source: "api-key",
      credentials: {
        access: credential,
        refresh: "",
        expires: now + 60 * 60_000,
      },
      createdAt: now,
      updatedAt: now,
    },
    policy,
  );
  const stored = loadAccount("openrouter-api", "live-proof", policy);
  assert.equal(stored?.credentials.access, credential);
  const encrypted = await readFile(
    path.join(policy.authRoot, "openrouter-api", "live-proof.json"),
    "utf8",
  );
  assert.ok(
    !encrypted.includes(credential),
    "Account storage must encrypt the credential",
  );
  // The selector must obtain the credential from storage, never ambient fallback.
  delete process.env.OPENROUTER_API_KEY;
  phase = "linked-account-selection";
  getDefaultAccountPool();
  const bridge = getCodingAgentSelectorBridge();
  assert.ok(bridge, "Production account selector was not installed");
  const selection = await bridge.select("pi-agent", {
    providerId: "openrouter-api",
    accountIds: ["live-proof"],
  });
  assert.equal(selection?.providerId, "openrouter-api");
  assert.equal(selection?.accountId, "live-proof");
  assert.equal(selection?.envPatch.OPENROUTER_API_KEY, credential);
  phase = "pi-provider-route";
  const route = await preparePiProviderRoute({
    sessionId: "live-proof",
    stateRoot: root,
    workdir,
    selection,
    model,
  });
  assert.equal(route.summary.piProviderId, "openrouter");
  assert.equal(route.summary.model, model);
  assert.equal(route.summary.billingMode, "api-credits-or-byok");
  const config = await readFile(
    path.join(route.env.PI_CODING_AGENT_DIR, "models.json"),
    "utf8",
  );
  assert.ok(
    !config.includes(credential),
    "Pi config must reference the child environment",
  );
  assert.equal(
    JSON.parse(config).providers.openrouter.baseUrl,
    "https://openrouter.ai/api/v1",
  );
  const env = {
    PATH: process.env.PATH,
    RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID,
    HOME: route.env.PI_CODING_AGENT_DIR,
    TMPDIR: process.env.TMPDIR,
    LANG: "C.UTF-8",
    XDG_CONFIG_HOME: path.join(route.env.PI_CODING_AGENT_DIR, "config"),
    XDG_CACHE_HOME: path.join(route.env.PI_CODING_AGENT_DIR, "cache"),
    PI_ACP_PI_COMMAND: "pi",
    ...route.env,
    PI_OFFLINE: "1",
  };
  enforcePiProviderCredentialIsolation(env);
  let actualModel;
  let response = "";
  let toolCall = false;
  let sentPrompt;
  const client = new NativeAcpClient({
    command: "pi-acp",
    expectedModelId: `openrouter/${model}`,
    cwd: workdir,
    approvalPreset: "readonly",
    terminal: false,
    timeoutMs: 90_000,
    env,
    onEvent(event) {
      if (event.result?.models?.currentModelId)
        actualModel = event.result.models.currentModelId;
      if (event.method === "session/prompt") sentPrompt = event.params.prompt;
      const update = event.params?.update;
      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      )
        response += update.content.text;
      if (update?.sessionUpdate === "tool_call") toolCall = true;
    },
    onStderr() {
      /* Raw provider diagnostics stay outside public evidence. */
    },
  });
  let result;
  const failures = [];
  try {
    phase = "pi-acp-initialize";
    await client.start();
    phase = "pi-selected-model-admission";
    const session = await client.createSession();
    assert.equal(actualModel, `openrouter/${model}`);
    phase = "live-provider-response";
    result = await client.prompt(session.sessionId, prompt);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.terminalFailure, undefined);
    assert.deepEqual(sentPrompt, [{ type: "text", text: prompt }]);
    assert.equal(
      toolCall,
      false,
      "Response-only check unexpectedly invoked a tool",
    );
    assert.equal(response.trim(), marker);
  } catch (error) {
    // error-policy:J2 Preserve response failure through mandatory native cleanup.
    failures.push(error);
  } finally {
    try {
      await client.close();
    } catch (cleanupError) {
      // error-policy:J2 Both response and cleanup failures remain failures.
      phase = "native-client-cleanup";
      failures.push(cleanupError);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Live Pi response or cleanup failed");
  const receipt = {
    schema: "eliza.pi-linked-account-live/v1",
    status: "passed",
    scope:
      "Real encrypted account storage and selector -> provider route -> Pi ACP -> official OpenRouter inference; not a UI enrollment proof",
    sourceSha: process.env.LIVE_PI_SOURCE_SHA,
    sourceSha256: Object.fromEntries(
      await Promise.all(
        sourcePaths.map(async (p) => [
          p,
          hash(await readFile(path.join(repo, p))),
        ]),
      ),
    ),
    provider: "openrouter",
    accountProvider: "openrouter-api",
    model,
    billingMode: route.summary.billingMode,
    confirmedAcpModel: actualModel,
    encryptedStorageReadback: true,
    ambientCredentialRemovedBeforeSelection: true,
    prompt,
    promptSha256: hash(prompt),
    response,
    responseSha256: hash(response),
    stopReason: result.stopReason,
    toolCalls: 0,
    nativeClientClosed: true,
    toolVersions: JSON.parse(process.env.LIVE_PI_TOOL_VERSIONS),
  };
  const serialized = JSON.stringify(receipt, null, 2);
  assert.ok(!serialized.includes(credential));
  assert.ok(!serialized.includes(root));
  await writeFile(path.join(root, "receipt.json"), `${serialized}\n`, {
    mode: 0o600,
  });
}

async function parent() {
  phase = "admission-opt-in";
  assert.equal(
    process.env.RUN_LIVE_PI_LINKED_ACCOUNT,
    "1",
    "Explicit live Pi opt-in is required",
  );
  phase = "admission-credential";
  const credential = process.env.OPENROUTER_API_KEY;
  assert.ok(
    credential?.trim(),
    "OPENROUTER_API_KEY is required; selected live checks never skip",
  );
  phase = "admission-source";
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  assert.equal(
    sourceSha,
    process.env.LIVE_PI_SOURCE_SHA,
    "Checkout must match the reviewed source SHA",
  );
  phase = "admission-tool-versions";
  assert.deepEqual(
    JSON.parse(process.env.LIVE_PI_TOOL_VERSIONS),
    { pi: "0.84.2", piAcp: "0.0.33", piAi: "0.84.4" },
    "Live tool versions must match reviewed pins",
  );
  phase = "admission-clean-checkout";
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
    "",
    "Live proof requires a clean reviewed checkout",
  );
  const destination = path.resolve(
    process.env.LIVE_PI_EVIDENCE_DIR || "artifacts/pi-linked-account",
  );
  phase = "admission-platform";
  assert.equal(
    process.platform,
    "linux",
    "This owned process-group proof requires Linux",
  );
  const container = await mkdtemp(
    path.join(tmpdir(), "eliza-pi-linked-account-"),
  );
  const root = path.join(container, "profile");
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  let receipt;
  const authorization = randomBytes(32).toString("hex");
  await writeFile(path.join(root, ".child-authorization"), authorization, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    const env = {
      PATH: process.env.PATH,
      RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID,
      HOME: root,
      ELIZA_HOME: root,
      ELIZA_STATE_DIR: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      TMPDIR: container,
      LANG: "C.UTF-8",
      CI: "true",
      PI_OFFLINE: "1",
      ELIZA_VAULT_DISABLE_KEYCHAIN: "1",
      ELIZA_VAULT_PASSPHRASE: randomBytes(32).toString("hex"),
      LIVE_PI_SOURCE_SHA: sourceSha,
      RUN_LIVE_PI_LINKED_ACCOUNT: "1",
      LIVE_PI_CHILD_AUTHORIZATION: authorization,
      OPENROUTER_API_KEY: credential,
      PI_ACP_PI_COMMAND: "pi",
      LIVE_PI_TOOL_VERSIONS: process.env.LIVE_PI_TOOL_VERSIONS,
    };
    phase = "child-execution";
    const result = await runOwnedChild(
      process.execPath,
      ["--conditions=eliza-source", script, "--child"],
      { cwd: repo, env },
      150_000,
    );
    if (result.code !== 0) {
      const failure = JSON.parse(
        await readFile(path.join(root, "failure.json"), "utf8"),
      );
      assert.ok(phases.has(failure.phase));
      phase = failure.phase;
      throw new Error(`Live Pi check failed during ${failure.phase}`);
    }
    receipt = JSON.parse(
      await readFile(path.join(root, "receipt.json"), "utf8"),
    );
  } finally {
    await rm(container, { recursive: true, force: true });
  }
  const serialized = JSON.stringify(
    { ...receipt, disposableProfileRemoved: true },
    null,
    2,
  );
  assert.ok(!serialized.includes(credential));
  assert.ok(!serialized.includes(root));
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "receipt.json"), `${serialized}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    "Live Pi linked-account qualification passed; sanitized receipt written.\n",
  );
}

/** Owns the Linux process group through natural exit, timeout, and descendant cleanup. */
export async function runOwnedChild(command, args, options, timeoutMs) {
  let timedOut = false;
  const proc = spawn(command, args, {
    ...options,
    detached: true,
    stdio: "ignore",
  });
  const signalGroup = (signal) => {
    if (!proc.pid) return false;
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch (error) {
      // error-policy:J6 ESRCH confirms that the owned group is already gone.
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  let parentSignal;
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      parentSignal = signal;
      signalGroup("SIGKILL");
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  let result;
  let retained = false;
  try {
    result = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        timedOut = true;
        try {
          signalGroup("SIGKILL");
        } catch (error) {
          reject(error);
        }
      }, timeoutMs);
      proc.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      proc.once("close", (code, signal) => {
        clearTimeout(deadline);
        resolve({ code, signal });
      });
    });
  } finally {
    try {
      retained = signalGroup(0);
      if (retained) {
        signalGroup("SIGKILL");
        const until = Date.now() + 5_000;
        while (signalGroup(0) && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
          signalGroup(0),
          false,
          "Owned Pi process group did not terminate",
        );
      }
    } finally {
      for (const [signal, handler] of signalHandlers)
        process.removeListener(signal, handler);
    }
  }
  assert.equal(
    parentSignal,
    undefined,
    "Live Pi check was interrupted by its parent signal",
  );
  assert.equal(
    timedOut,
    false,
    "Live Pi check exceeded its owned-process deadline",
  );
  assert.equal(
    retained,
    false,
    "Live Pi child retained descendants after completion",
  );
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(script)) {
  try {
    if (process.argv.includes("--child")) await child();
    else await parent();
  } catch {
    // error-policy:J1 Publish only the fixed phase, never credential-bearing library errors.
    if (process.argv.includes("--child") && childAdmitted) {
      await writeFile(
        path.join(process.env.ELIZA_HOME, "failure.json"),
        JSON.stringify({ phase }),
        { mode: 0o600 },
      );
    }
    if (!process.argv.includes("--child") && process.env.LIVE_PI_EVIDENCE_DIR) {
      const destination = path.resolve(process.env.LIVE_PI_EVIDENCE_DIR);
      await mkdir(destination, { recursive: true });
      await writeFile(
        path.join(destination, "receipt.json"),
        JSON.stringify(
          {
            schema: "eliza.pi-linked-account-live/v1",
            status: "failed",
            phase,
            sourceSha: process.env.LIVE_PI_SOURCE_SHA || null,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
    process.stderr.write(
      `Live Pi linked-account qualification failed during ${phase}.\n`,
    );
    process.exitCode = 1;
  }
}
