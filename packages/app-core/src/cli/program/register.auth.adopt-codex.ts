/**
 * `eliza auth adopt-codex` — the operator-facing surface for adopting a Codex
 * CLI login (`CODEX_HOME/auth.json`) into the account pool.
 *
 * Adoption is a destructive ownership transfer: the source file is retired so
 * the `codex` CLI can no longer refresh the chain (OpenAI refresh tokens are
 * one-time-use; two refreshers revoke the whole grant family). The command
 * therefore requires an explicit `--yes` — without it, it prints exactly what
 * would happen and exits non-zero so scripts cannot adopt by accident.
 */

import { theme } from "@elizaos/shared";
import type { Command } from "commander";

export interface AdoptCodexCliParams {
  accountId?: string;
  codexHome?: string;
  overwrite?: boolean;
  /** The explicit confirmation. Without it the command only describes the op. */
  yes?: boolean;
  log?: (line: string) => void;
}

export interface AdoptCodexCliResult {
  ok: boolean;
  /** Set on success. */
  accountId?: string;
  retiredTo?: string;
  organizationId?: string;
  /** Set on failure: the ElizaError code (adopt_codex.*) or "not_confirmed". */
  reason?: string;
  message?: string;
}

/**
 * Test-callable entry point; the commander action wraps it. Drives the real
 * adoption in @elizaos/auth — no simulation layer.
 */
export async function runAuthAdoptCodex(
  params: AdoptCodexCliParams = {},
): Promise<AdoptCodexCliResult> {
  // CLI stdout is the interface here; write directly rather than console.*
  // (the logger-only rule covers server runtime paths).
  const log =
    params.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const accountId = params.accountId ?? "default";

  if (!params.yes) {
    log(theme.heading("Codex login adoption (dry description)"));
    log(
      `This RETIRES the Codex CLI login (auth.json is renamed out of the CLI's read path) and stores its tokens as pool account ${theme.command(`openai-codex/${accountId}`)}.`,
    );
    log(
      "After adoption the `codex` CLI is logged out on this machine — the pool becomes the only refresher of this chain.",
    );
    log(
      theme.error(
        "Stop every running codex process first, then re-run with --yes to proceed.",
      ),
    );
    return {
      ok: false,
      reason: "not_confirmed",
      message: "adoption requires explicit --yes",
    };
  }

  // Concrete subpath import — the documented consumption pattern for the
  // @elizaos/auth leaf package (see its package guide).
  const { adoptCodexCliLogin } = await import(
    "@elizaos/auth/subscription-auth/adopt-codex-cli-login"
  );
  try {
    const result = adoptCodexCliLogin({
      accountId,
      ...(params.codexHome ? { codexHome: params.codexHome } : {}),
      ...(params.overwrite ? { overwrite: true } : {}),
    });
    log(
      `${theme.success("✓")} adopted Codex login as ${theme.command(`openai-codex/${result.accountId}`)}`,
    );
    log(
      `${theme.success("✓")} source retired to ${theme.command(result.retiredTo)} — the codex CLI can no longer refresh this chain`,
    );
    if (result.organizationId) {
      log(`${theme.muted("→")} org ${result.organizationId}`);
    }
    return {
      ok: true,
      accountId: result.accountId,
      retiredTo: result.retiredTo,
      ...(result.organizationId
        ? { organizationId: result.organizationId }
        : {}),
    };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    log(theme.error(`adoption failed (${code}): ${message}`));
    return { ok: false, reason: code, message };
  }
}

/**
 * Attach `adopt-codex` under the existing `auth` command group (creating the
 * group only if a build ever registers this before `registerAuthCommand`).
 */
export function registerAuthAdoptCodexSubcommand(program: Command): void {
  const auth =
    program.commands.find((c) => c.name() === "auth") ??
    program.command("auth").description("Manage Eliza auth state");

  auth
    .command("adopt-codex")
    .description(
      "Adopt the Codex CLI login into the account pool and retire the source (destructive; requires --yes)",
    )
    .option("--account <id>", "Pool account id to create", "default")
    .option(
      "--codex-home <path>",
      "CODEX_HOME to adopt from (default $CODEX_HOME or ~/.codex)",
    )
    .option("--overwrite", "Replace an existing pool account with this id")
    .option("--yes", "Confirm the destructive ownership transfer")
    .option("--json", "Emit the result as JSON (for scripting)")
    .action(
      async (opts: {
        account?: string;
        codexHome?: string;
        overwrite?: boolean;
        yes?: boolean;
        json?: boolean;
      }) => {
        const result = await runAuthAdoptCodex({
          accountId: opts.account,
          codexHome: opts.codexHome,
          overwrite: opts.overwrite,
          yes: opts.yes,
        });
        if (opts.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        if (!result.ok) process.exitCode = 1;
      },
    );
}
