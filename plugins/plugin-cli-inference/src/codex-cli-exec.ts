import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/core";
import {
  __setSpawnForTests as __setClaudeSpawn,
  type ClaudeGenerateParams,
  defaultSpawn,
  type SpawnFn,
  type SpawnResult,
} from "./claude-cli";
import { flattenPrompt } from "./prompt-flatten";
import { filterEnv, redactSensitive, resolveSafeBinary, resolveSafeCwd } from "./sandbox";

/**
 * Codex CLI inference variant (TOS-clean SAFE/CLOUD route).
 *
 * Spawns the sanctioned `codex exec` binary, which reads its OWN OAuth creds
 * from `~/.codex/auth.json`. As with the claude variant, eliza never sees or
 * forwards the subscription token; the child env is `filterEnv`'d and stderr is
 * redacted before logging. `codex exec` runs read-only in an isolated cwd.
 *
 * codex `exec` stdout is noisier than `claude --output-format text`: we request
 * `--json` (JSONL events) and pull the LAST assistant message text, falling
 * back to the raw trimmed stdout if no JSONL assistant event was emitted.
 */

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 120_000;
const CODEX_BINARY = "codex";

// Reuse the spawner seam from claude-cli so tests can mock a single spawn fn.
// Defaults to the real `defaultSpawn` (mirrors the claude variant) so a
// production codex call works without any test seam being installed.
let spawnImpl: SpawnFn = defaultSpawn;

/** Test seam: swap the child-process spawner used by BOTH CLI variants. */
export function __setSpawnForTests(fn: SpawnFn): () => void {
  const prev = spawnImpl;
  spawnImpl = fn;
  // Also route the claude variant through the same mock for a single seam.
  const restoreClaude = __setClaudeSpawn(fn);
  return () => {
    spawnImpl = prev;
    restoreClaude();
  };
}

export interface CodexCliConfig {
  model?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Injected spawner; defaults to the seam set via `__setSpawnForTests`. */
  spawnFn?: SpawnFn;
  /**
   * Pin the resolved binary path, skipping `resolveSafeBinary`. Used by unit
   * tests and by container deploys that pin the CLI outside the default
   * allowlist. When unset, the binary is resolved from PATH against the SOC2
   * whitelist.
   */
  binaryPath?: string;
}

function redactStderr(stderr: string): string {
  return redactSensitive(stderr).slice(0, 2000);
}

export class CodexParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexParseError";
  }
}

/**
 * Extract the assistant text from codex `--json` JSONL stdout. codex emits one
 * JSON object per line; the assistant's answer arrives as an `agent_message` /
 * `item.completed` (message) event, and a long answer can be split across
 * several such events. We concatenate EVERY assistant fragment in emission
 * order (truncating to the last one would drop split `<response>` blocks).
 *
 * Returns `{ ok: true, text }` when at least one assistant fragment was found,
 * `{ ok: false, sawJson }` otherwise. `sawJson` is true when any line parsed as
 * JSON — the caller falls back to raw stdout ONLY when zero lines were JSON
 * (real banner-only output); if lines were JSON but none were assistant events,
 * the caller throws rather than dumping the raw JSONL to the channel.
 */
function collectAssistantFragments(
  stdout: string
): { ok: true; text: string } | { ok: false; sawJson: boolean } {
  const lines = stdout.split(/\r?\n/);
  const fragments: string[] = [];
  let sawJson = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== "{") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    sawJson = true;
    const text = extractAssistantText(obj);
    if (text && text.trim().length > 0) fragments.push(text.trim());
  }
  if (fragments.length > 0) return { ok: true, text: fragments.join("\n") };
  return { ok: false, sawJson };
}

/**
 * Parse codex `--json` JSONL stdout into the assistant answer, concatenating
 * all assistant fragments in order. Falls back to the raw trimmed stdout ONLY
 * when no line was JSON at all (banner-only output). If lines parsed as JSON but
 * none were assistant events, throws `CodexParseError` rather than leaking the
 * raw JSONL to the channel.
 */
export function parseCodexJsonl(stdout: string): string {
  const result = collectAssistantFragments(stdout);
  if (result.ok) return result.text;
  if (result.sawJson) {
    throw new CodexParseError(
      "[cli-inference] codex emitted JSONL events but no assistant message was found"
    );
  }
  return stdout.trim();
}

function extractAssistantText(obj: unknown): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const record = obj as Record<string, unknown>;

  // Newer codex: { type: "item.completed", item: { type: "message"|"agent_message", text } }
  const item = record.item;
  if (typeof item === "object" && item !== null) {
    const itemRecord = item as Record<string, unknown>;
    const itemType = itemRecord.type;
    if (
      itemType === "message" ||
      itemType === "agent_message" ||
      itemType === "assistant_message"
    ) {
      const text = pickText(itemRecord);
      if (text) return text;
    }
  }

  // Flat shape: { type: "agent_message", message|text }
  const type = record.type;
  if (type === "agent_message" || type === "assistant_message" || type === "message") {
    const text = pickText(record);
    if (text) return text;
  }
  return undefined;
}

function pickText(record: Record<string, unknown>): string | undefined {
  for (const key of ["text", "message", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export class CodexCli {
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn?: SpawnFn;
  private readonly binaryPath?: string;

  constructor(config: CodexCliConfig = {}) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = config.env ?? process.env;
    this.spawnFn = config.spawnFn;
    this.binaryPath = config.binaryPath;
  }

  private getSpawn(): SpawnFn {
    return this.spawnFn ?? spawnImpl;
  }

  async generate(params: ClaudeGenerateParams): Promise<string> {
    const { system, body } = flattenPrompt(params);
    // codex `exec` takes ONE positional prompt — fold the system block on top.
    const prompt = system.trim().length > 0 ? `${system}\n\n${body}` : body;
    const binary = this.binaryPath ?? resolveSafeBinary(CODEX_BINARY, this.env);

    const rawCwd = await mkdtemp(join(tmpdir(), "eliza-cli-inference-"));
    const cwd = resolveSafeCwd(rawCwd, [tmpdir()]);

    try {
      const argv = [
        binary,
        "exec",
        "-m",
        this.model,
        "-s",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        cwd,
        "--color",
        "never",
        "--json",
        prompt,
      ];

      const result: SpawnResult = await this.getSpawn()(argv, {
        cwd,
        env: filterEnv(this.env),
        timeoutMs: this.timeoutMs,
        stdinPath: "/dev/null",
      });

      if (result.timedOut) {
        throw new Error(
          `[cli-inference] codex timed out after ${this.timeoutMs}ms (SIGTERM): ${redactStderr(result.stderr)}`
        );
      }
      if (result.code !== 0) {
        throw new Error(
          `[cli-inference] codex exited ${result.code} signal=${result.signal}: ${redactStderr(result.stderr)}`
        );
      }
      // parseCodexJsonl already handles the banner-only fallback and throws
      // (rather than dumping raw JSONL) when JSON events were present but none
      // were assistant messages.
      const text = parseCodexJsonl(result.stdout);
      if (text.length === 0) {
        throw new Error(
          `[cli-inference] codex returned empty stdout: ${redactStderr(result.stderr)}`
        );
      }
      return text;
    } finally {
      await rm(rawCwd, { recursive: true, force: true }).catch((err) => {
        logger.debug(`[cli-inference] failed to clean isolated cwd ${rawCwd}: ${String(err)}`);
      });
    }
  }
}
