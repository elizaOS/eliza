/**
 * Exercises delayed volume preparation through the actual vault transport and
 * local shell. Linux ownership and flock are substituted; this proves the
 * cancellation boundary and filesystem effects, not cross-process exclusion.
 */
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProtectedHostDirectoryCommands,
  ensureVolumeVaultPassphrase,
  shellQuote,
} from "./docker-sandbox-utils";

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

test("protected directory preparation refuses symlinks and writable parents before child writes", () => {
  const root = mkdtempSync(join(tmpdir(), "eliza-protected-volume-"));
  const bin = join(root, "bin");
  const volume = join(root, "volume");
  const target = join(root, "other-agent");
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(target, { mode: 0o700 });
  const sentinel = join(target, "preserve");
  writeFileSync(sentinel, "other agent data");
  // Fixture ownership is simulated; real stat supplies directory permissions.
  const nativeModeCommand =
    process.platform === "darwin" ? '/usr/bin/stat -f %Lp "$4"' : '/usr/bin/stat -c %a -- "$4"';
  writeFileSync(
    join(bin, "stat"),
    `#!/bin/sh\ncase "$2" in "%u") printf '%s' "$FIXTURE_UID" ;; "%a") ${nativeModeCommand} ;; *) exit 64 ;; esac\n`,
    { mode: 0o700 },
  );
  const run = (uid = "0") =>
    spawnSync(
      "/bin/sh",
      [
        "-c",
        [
          "set -eu",
          ...buildProtectedHostDirectoryCommands(volume, true),
          ...buildProtectedHostDirectoryCommands(`${volume}/eliza`, true),
          `printf seeded > ${shellQuote(`${volume}/eliza/seed`)}`,
        ].join("; "),
      ],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_UID: uid } },
    );
  try {
    symlinkSync(target, volume);
    expect(run().status).toBe(45);
    expect(existsSync(join(target, "eliza"))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("other agent data");
    rmSync(volume);
    mkdirSync(volume, { mode: 0o700 });
    chmodSync(volume, 0o777);
    expect(run().status).toBe(45);
    expect(existsSync(join(volume, "eliza"))).toBe(false);
    chmodSync(volume, 0o700);
    expect(run("1000").status).toBe(45);
    expect(existsSync(join(volume, "eliza"))).toBe(false);
    expect(run().status).toBe(0);
    expect(readFileSync(join(volume, "eliza", "seed"), "utf8")).toBe("seeded");
    expect(run().status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
