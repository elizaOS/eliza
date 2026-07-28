/**
 * Selects the provider-controlled restore-validation boot path before the
 * normal agent runtime can perform any process-wide initialization. Unknown
 * values fail closed so a misspelled recovery mode cannot boot a writable
 * agent.
 */
import { ElizaError } from "@elizaos/core";

export const RESTORE_VALIDATION_BOOT_MODE = "restore-validation";

export type RuntimeBootMode = "normal" | typeof RESTORE_VALIDATION_BOOT_MODE;

export function resolveRuntimeBootMode(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeBootMode {
  const value = env.ELIZA_RUNTIME_BOOT_MODE?.trim();
  if (!value) return "normal";
  if (value === RESTORE_VALIDATION_BOOT_MODE) return value;
  throw new ElizaError(`Unsupported runtime boot mode: ${value}`, {
    code: "RUNTIME_BOOT_MODE_INVALID",
    context: { value },
    severity: "fatal",
  });
}

export function assertNormalRuntimeBootMode(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resolveRuntimeBootMode(env) === RESTORE_VALIDATION_BOOT_MODE) {
    throw new ElizaError(
      "Restore-validation boot cannot enter the full agent runtime",
      {
        code: "RUNTIME_BOOT_MODE_BOUNDARY_VIOLATION",
        severity: "fatal",
      },
    );
  }
}
