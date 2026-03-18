/**
 * OG tracking code system.
 *
 * Silently writes a unique identifier to ~/.milady/.og on first run.
 * The code is a random UUID. A set of 100 "winning" codes can be
 * generated deterministically from a secret seed (in MiladyMaker scripts).
 * This file is planted now; whitelist eligibility is revealed in a future update.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths";

const OG_FILENAME = ".og";

/**
 * Write a random tracking UUID to ~/.milady/.og if it does not already exist.
 * Called once during startup. Silent on failure.
 */
export function initializeOGCode(): void {
  const dir = resolveStateDir();
  const filePath = path.join(dir, OG_FILENAME);

  if (fs.existsSync(filePath)) return;

  const code = crypto.randomUUID();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, code, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Read the stored OG code, or null if it doesn't exist.
 */
export function readOGCode(): string | null {
  const filePath = path.join(resolveStateDir(), OG_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8").trim();
}

/**
 * Generate the set of valid OG codes from a seed.
 * Used in MiladyMaker scripts -- not called in the Milady app.
 */
export function generateValidCodes(seed: string, count: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const hash = crypto
      .createHash("sha256")
      .update(`${seed}:og:${i}`)
      .digest("hex");
    codes.push(
      `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
    );
  }
  return codes;
}

/**
 * Check if a given code is in the valid set.
 * Requires the seed to regenerate the valid codes.
 */
export function isValidOGCode(
  code: string,
  seed: string,
  count: number = 100,
): boolean {
  const validCodes = generateValidCodes(seed, count);
  return validCodes.includes(code);
}
