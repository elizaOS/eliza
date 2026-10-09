/**
 * Child fixture for the protected-profile boot e2e: runs the real standalone
 * boot (`startElizaProcess`, the path `bin.js start` runs) under the protected
 * profile and prints one `PROTECTED_RESULT=<json>` line with the boot outcome
 * and every boot phase that began.
 */
import { startElizaProcess } from "../../src/runtime/eliza.ts";

const phases: string[] = [];
try {
  await startElizaProcess({
    serverOnly: true,
    onBootPhase: (phase) => phases.push(phase),
  });
  process.stdout.write(
    `PROTECTED_RESULT=${JSON.stringify({ booted: true, phases })}\n`,
  );
  process.exit(0);
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  process.stdout.write(
    `PROTECTED_RESULT=${JSON.stringify({ booted: false, code, phases })}\n`,
  );
  process.exit(1);
}
