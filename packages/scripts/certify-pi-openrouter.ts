/** Certifies one live OpenRouter route through the production native ACP transport and a pinned real Pi adapter. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repository = process.env.GITHUB_WORKSPACE;
const adapter = process.env.PI_CERT_ADAPTER;
const artifactRoot = process.env.PI_CERT_ARTIFACT_ROOT;
const key = process.env.OPENROUTER_API_KEY;
if (!repository || !adapter || !artifactRoot || !key) {
  throw new Error(
    "Certification requires repository, pinned adapter, artifact path, and OpenRouter credential",
  );
}
const { preparePiProviderRoute } = await import(
  path.join(
    repository,
    "plugins/plugin-agent-orchestrator/src/services/pi-provider-config.ts",
  )
);
const { NativeAcpClient } = await import(
  path.join(
    repository,
    "plugins/plugin-agent-orchestrator/src/services/acp-native-transport.ts",
  )
);
const stateRoot = await mkdtemp(
  path.join(tmpdir(), "pi-openrouter-certification-"),
);
const workspace = path.join(stateRoot, "workspace");
await mkdir(workspace, { mode: 0o700 });
await mkdir(artifactRoot, { recursive: true });
const pidFile = path.join(stateRoot, "adapter.pid");
const wrapper = path.join(stateRoot, "adapter-launch");
const piWrapper = path.join(stateRoot, "pi-no-tools");
const piPidFile = path.join(stateRoot, "pi.pid");
await writeFile(
  piWrapper,
  '#!/bin/sh\nprintf "%s\\n" "$$" > "$PI_CERT_PI_PID_FILE"\nexec "$PI_CERT_PI" --no-tools --no-extensions --no-skills "$@"\n',
  { mode: 0o700 },
);
await writeFile(
  wrapper,
  '#!/bin/sh\nprintf "%s\\n" "$$" > "$PI_CERT_PID_FILE"\nexec "$PI_CERT_ADAPTER"\n',
  { mode: 0o700 },
);
const prompt =
  "Reply with exactly PI_OPENROUTER_CERTIFIED_20260905. Do not use tools.";
const prepared = await preparePiProviderRoute({
  sessionId: "openrouter-certification",
  stateRoot,
  model: "anthropic/claude-sonnet-4",
  selection: {
    providerId: "openrouter-api",
    accountId: "certification",
    label: "certification",
    source: "api-key",
    strategy: "priority",
    envPatch: { OPENROUTER_API_KEY: key },
  },
});
const settingsPath = path.join(
  prepared.env.PI_CODING_AGENT_DIR,
  "settings.json",
);
await writeFile(
  settingsPath,
  JSON.stringify({
    ...JSON.parse(await readFile(settingsPath, "utf8")),
    quietStartup: true,
  }),
);
let text = "";
let stderrBytes = 0;
const stderrHash = createHash("sha256");
let toolCalls = 0;
let promptRequests = 0;
let phase = "initialize";
let sessionId: string | undefined;
let stopReason: string | undefined;
let passed = false;
let cleanupPassed = false;
let pid: number | undefined;
let piPid: number | undefined;
const client = new NativeAcpClient({
  command: wrapper,
  cwd: workspace,
  approvalPreset: "readonly",
  terminal: false,
  timeoutMs: 60_000,
  mcpServers: [],
  env: {
    PATH: process.env.PATH,
    HOME: stateRoot,
    PI_CERT_ADAPTER: adapter,
    PI_CERT_PID_FILE: pidFile,
    PI_ACP_PI_COMMAND: piWrapper,
    PI_CERT_PI: path.join(path.dirname(adapter), "pi"),
    PI_CERT_PI_PID_FILE: piPidFile,
    ...prepared.env,
  },
  onStderr(chunk: string) {
    stderrBytes += Buffer.byteLength(chunk);
    stderrHash.update(chunk);
  },
  onEvent(event: {
    method?: string;
    params?: {
      update?: {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
      };
    };
  }) {
    if (phase !== "prompt") return;
    const update = event.params?.update;
    if (event.method !== "session/update" || !update) return;
    if (update.sessionUpdate === "tool_call") toolCalls += 1;
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    )
      text += update.content.text;
  },
});
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    (async () => {
      await client.start();
      pid = Number((await readFile(pidFile, "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("Missing adapter process identity");
      phase = "session";
      const session = await client.createSession(workspace);
      sessionId = session.sessionId;
      if (!sessionId) throw new Error("Missing ACP session identity");
      piPid = Number((await readFile(piPidFile, "utf8")).trim());
      if (!Number.isSafeInteger(piPid) || piPid < 1)
        throw new Error("Missing Pi process identity");
      phase = "prompt";
      promptRequests += 1;
      const result = await client.prompt(sessionId, prompt);
      stopReason = result.stopReason;
      passed =
        !result.terminalFailure &&
        stopReason === "end_turn" &&
        toolCalls === 0 &&
        text.trim() === "PI_OPENROUTER_CERTIFIED_20260905";
      phase = "complete";
    })(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Certification deadline exceeded")),
        120_000,
      );
    }),
  ]);
} catch {
  // error-policy:J1 Certification reports the failing phase without retaining provider headers, credentials, or raw transport errors.
  passed = false;
} finally {
  if (timer) clearTimeout(timer);
  try {
    await client.close();
  } catch {
    // error-policy:J1 A transport teardown failure makes certification fail without recording credential-bearing errors.
    passed = false;
  } finally {
    try {
      if (pid === undefined)
        pid = Number((await readFile(pidFile, "utf8")).trim());
      if (piPid === undefined)
        piPid = Number((await readFile(piPidFile, "utf8")).trim());
      // Adapter EOF and descendant exit can be observed on different turns.
      // Require both exact identities to disappear within a bounded grace period.
      const cleanupDeadline = performance.now() + 5_000;
      do {
        cleanupPassed = [pid, piPid].every((ownedPid) => {
          if (!Number.isSafeInteger(ownedPid) || ownedPid < 1) return false;
          try {
            process.kill(ownedPid, 0);
            return false;
          } catch (error) {
            // error-policy:J3 Only ESRCH proves the owned process exited; other observations fail closed.
            return (
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            );
          }
        });
        if (cleanupPassed || performance.now() >= cleanupDeadline) break;
        await delay(50);
      } while (true);
    } catch {
      // error-policy:J1 Missing process identity leaves cleanup unverified.
      cleanupPassed = false;
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }
}
if (text.includes(key))
  throw new Error("Credential-shaped output rejected before artifact write");
await writeFile(
  path.join(artifactRoot, "certification.json"),
  `${JSON.stringify(
    {
      schema: 1,
      commit: process.env.GITHUB_SHA,
      provider: "openrouter-api",
      model: prepared.summary.model,
      piVersion: "0.85.1",
      adapterVersion: "0.0.33",
      prompt,
      output: text,
      sessionId,
      stopReason,
      toolCalls,
      promptRequests,
      stderrBytes,
      stderrSha256: stderrHash.digest("hex"),
      phase,
      pid,
      piPid,
      toolsDisabled: true,
      passed,
      cleanupPassed,
      remainingRoutes:
        "Six routes have no live-provider certification in this run",
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
if (!passed || !cleanupPassed) process.exitCode = 1;
