/**
 * Password-manager reference resolver for external vault entries.
 *
 * Resolves 1Password and Proton Pass pointers through their CLIs when callers
 * explicitly request the referenced secret value.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PasswordManagerReference } from "./types.js";

const exec = promisify(execFile);

/**
 * Resolve a password-manager reference at use time.
 *
 * 1Password: shells out to `op read op://<vault>/<item>/<field>`.
 * Proton Pass: shells out to `pass-cli item view pass://<vault>/<item>/<field>`.
 *
 * The reference contents are never copied to disk by the vault; only
 * the reference itself (`{ source, path }`) is stored.
 */

export class PasswordManagerError extends Error {
  constructor(
    readonly source: PasswordManagerReference["source"],
    message: string,
  ) {
    super(`[${source}] ${message}`);
    this.name = "PasswordManagerError";
  }
}

export async function resolveReference(
  ref: PasswordManagerReference,
): Promise<string> {
  if (ref.source === "1password") return resolve1Password(ref.path);
  if (ref.source === "protonpass") return resolveProtonPass(ref.path);
  throw new PasswordManagerError(ref.source, "unsupported source");
}

async function resolve1Password(path: string): Promise<string> {
  const uri = path.startsWith("op://") ? path : `op://${path}`;
  try {
    const { stdout } = await exec("op", ["read", uri], {
      encoding: "utf8",
      timeout: 5000,
    });
    const value = stdout.trim();
    if (value.length === 0) {
      throw new PasswordManagerError("1password", `${uri} is empty`);
    }
    return value;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new PasswordManagerError(
        "1password",
        "`op` CLI not found. Install from https://developer.1password.com/docs/cli, then sign in (`eval $(op signin)`).",
      );
    }
    if (err instanceof PasswordManagerError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/not signed in|not authenticated/i.test(msg)) {
      throw new PasswordManagerError(
        "1password",
        "`op` is not signed in. Unlock the 1Password desktop app or run `eval $(op signin)`.",
      );
    }
    throw new PasswordManagerError("1password", msg);
  }
}

async function resolveProtonPass(path: string): Promise<string> {
  const uri = path.startsWith("pass://") ? path : `pass://${path}`;
  try {
    const { stdout } = await exec("pass-cli", ["item", "view", uri], {
      encoding: "utf8",
      timeout: 5000,
    });
    const value = stdout.trim();
    if (value.length === 0) {
      throw new PasswordManagerError("protonpass", `${uri} is empty`);
    }
    return value;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new PasswordManagerError(
        "protonpass",
        "`pass-cli` not found. Install Proton Pass CLI from https://protonpass.github.io/pass-cli/.",
      );
    }
    if (err instanceof PasswordManagerError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /not signed in|not authenticated|not logged in|login required/i.test(msg)
    ) {
      throw new PasswordManagerError(
        "protonpass",
        "`pass-cli` is not signed in. Authenticate with Proton Pass CLI before resolving vault references.",
      );
    }
    throw new PasswordManagerError("protonpass", msg);
  }
}
