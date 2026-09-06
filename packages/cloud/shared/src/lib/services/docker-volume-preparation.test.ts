/**
 * Exercises delayed volume preparation through the actual vault transport and
 * local shell. Linux ownership and flock are substituted; this proves the
 * cancellation boundary and filesystem effects, not cross-process exclusion.
 */
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVolumeVaultPassphrase, shellQuote } from "./docker-sandbox-utils";

test("cancelled replacement cannot recreate its removed volume during vault preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "eliza-cancelled-volume-"));
  const bin = join(root, "bin");
  const attempts = join(root, "attempts");
  const volume = join(root, "volume");
  const attemptId = "33333333-3333-4333-8333-333333333333";
  const productionVolume = "/data/agents/11111111-1111-4111-8111-111111111111";
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(join(attempts, attemptId), { recursive: true, mode: 0o700 });
  writeFileSync(join(attempts, attemptId, "cancelled"), "", { mode: 0o600 });
  writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(
    join(bin, "stat"),
    '#!/bin/sh\ncase "$2" in "%u") printf 0 ;; "%a") if test -d "$4"; then printf 700; else printf 600; fi ;; "%h") printf 1 ;; *) exit 64 ;; esac\n',
    { mode: 0o700 },
  );
  let dispatches = 0;
  const execStdin = async (command: string, input: string): Promise<string> => {
    dispatches++;
    const remapped = command
      .replaceAll(productionVolume, volume)
      .replaceAll("/var/lib/eliza/replacement-attempts", attempts)
      .replaceAll("chmod 700 --", "chmod 700")
      .replaceAll("chmod 600 --", "chmod 600");
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", remapped], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(output);
        else reject(new Error(`Remote shell exited with code ${code}`));
      });
      child.stdin.end(input);
    });
  };
  try {
    await expect(
      ensureVolumeVaultPassphrase(execStdin, productionVolume, 5_000, undefined, attemptId, [
        `mkdir -p ${shellQuote(productionVolume)}`,
      ]),
    ).rejects.toThrow("exited with code 75");
    expect(dispatches).toBe(1);
    expect(existsSync(volume)).toBe(false);
    expect(existsSync(join(attempts, attemptId, "vault-stdin"))).toBe(false);

    await expect(
      ensureVolumeVaultPassphrase(execStdin, productionVolume, 5_000, undefined, undefined, [
        `mkdir -p ${shellQuote(productionVolume)}`,
      ]),
    ).rejects.toThrow("require a fenced replacement attempt");
    expect(dispatches).toBe(1);
    expect(existsSync(volume)).toBe(false);

    // Preparation belongs to the admitted frame: a preparation failure stops
    // secret upload, while the real directory effect proves it was executed.
    const activeAttempt = "44444444-4444-4444-8444-444444444444";
    await expect(
      ensureVolumeVaultPassphrase(execStdin, productionVolume, 5_000, undefined, activeAttempt, [
        `mkdir -p ${shellQuote(productionVolume)}`,
        "exit 79",
      ]),
    ).rejects.toThrow("exited with code 79");
    expect(existsSync(volume)).toBe(true);
    expect(existsSync(join(attempts, activeAttempt, "vault-stdin"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
