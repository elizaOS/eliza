// Subscription-only live-model lane for the LifeOps GEPA seed runner
// (#11384, unblocked by #10757).
//
// Hosts with no Cerebras/Anthropic API key but a Claude subscription can run
// the per-capability GEPA loop through the sanctioned `claude --print` binary.
// This reuses plugin-cli-inference's hardened `ClaudeCli` (isolated tmp cwd,
// env filtering, SOC2 binary allowlist, stderr redaction) rather than
// re-implementing the spawn, and adapts it to the `EvalModelClient` shape the
// optimizer + judge consume.
//
// Knobs (mirroring the runtime plugin):
//   ELIZA_CLI_MODEL       model id passed to `claude --model` (default haiku)
//   ELIZA_CLI_TIMEOUT_MS  per-call timeout (default 240 s)
//
// The CLI does not expose temperature / max-token controls, so those request
// fields are accepted and ignored — completions for these tasks are short and
// instruction-bounded.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCli } from "../../../plugin-cli-inference/src/claude-cli.ts";
import type { EvalModelClient } from "../../src/core/cerebras-eval-model.ts";

const DEFAULT_CLI_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_CLI_TIMEOUT_MS = 240_000;

export function cliCredentialsPresent(): boolean {
  return existsSync(join(homedir(), ".claude", ".credentials.json"));
}

export function resolveCliModel(): string {
  const explicit = process.env.ELIZA_CLI_MODEL?.trim();
  return explicit && explicit.length > 0 ? explicit : DEFAULT_CLI_MODEL;
}

function resolveCliTimeoutMs(): number {
  const raw = process.env.ELIZA_CLI_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CLI_TIMEOUT_MS;
}

/**
 * `EvalModelClient` backed by `claude --print` (subscription credentials,
 * read by the CLI itself from `~/.claude/.credentials.json` — never injected
 * into the child env).
 */
export function getCliModelClient(): EvalModelClient {
  if (!cliCredentialsPresent()) {
    throw new Error(
      "[cli-model] ~/.claude/.credentials.json not found — the cli provider " +
        "needs a logged-in claude CLI (run `claude login`) or use " +
        "TRAIN_MODEL_PROVIDER=cerebras|anthropic with an API key.",
    );
  }
  const cli = new ClaudeCli({
    model: resolveCliModel(),
    timeoutMs: resolveCliTimeoutMs(),
  });
  return async (req) => {
    const text = await cli.generate({
      system: req.systemPrompt,
      prompt: req.prompt,
    });
    return { text };
  };
}
