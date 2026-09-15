/**
 * Exercises the restore vault seed transport with deterministic in-memory
 * adapters and the exact shell command against a temporary local directory.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_BACKUP_RESTORE_STAGING_VOLUME_PATH_DERIVATION_V1,
  AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES,
  AGENT_BACKUP_RESTORE_VAULT_VOLUME_SEED_RECEIPT_FORMAT,
  buildRestoreVolumeVaultSeedReceiptV1,
  deriveRestoreStagingVolumePathV1,
  seedRestoreVolumeVaultPassphraseBytes,
} from "./agent-backup-restore-vault-seed";
import {
  buildVolumeVaultPassphraseCommand,
  getVolumeVaultPassphrasePath,
  shellQuote,
  VOLUME_VAULT_STDIN_FRAME_END,
  VOLUME_VAULT_STDIN_FRAME_VERSION,
} from "./docker-sandbox-utils";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESTORE_ATTEMPT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPLACEMENT_ATTEMPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SYMLINK_ATTEMPT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RESTORE_ROOT = "/data/agents/.restore";
const AGENT_ROOT = `${RESTORE_ROOT}/${AGENT_ID}`;
const VOLUME_PATH = `${AGENT_ROOT}/${RESTORE_ATTEMPT_ID}`;

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safePassphrase(fill: number): Uint8Array {
  return new Uint8Array(64).fill(fill);
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function expectedSafeDirectoryProof(path: string): string[] {
  const quoted = shellQuote(path);
  return [
    `test -d ${quoted} && test ! -L ${quoted} || exit 45`,
    `test "$(stat -c '%u' -- ${quoted})" = 0 || exit 45`,
    `directory_mode=$(stat -c '%a' -- ${quoted}); case "$directory_mode" in *[2367][0-7]|*[0-7][2367]) exit 45 ;; esac`,
  ];
}

function expectedDirectoryPreparation(path: string): string[] {
  const quoted = shellQuote(path);
  return [
    `if test -e ${quoted} || test -L ${quoted}; then ${expectedSafeDirectoryProof(path).join("; ")}; else install -d -m 700 ${quoted}; fi`,
    ...expectedSafeDirectoryProof(path),
  ];
}

async function execLocalShell(
  command: string,
  stdin: Buffer,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const child = spawn("/bin/sh", ["-c", command], { env: { ...process.env, ...env } });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(Object.assign(new Error(stderr || `shell exited ${code}`), { code }));
    });
    child.stdin.end(stdin);
  });
}

describe("seedRestoreVolumeVaultPassphraseBytes", () => {
  test("derives only an attempt-scoped staging path", () => {
    expect(deriveRestoreStagingVolumePathV1(AGENT_ID, RESTORE_ATTEMPT_ID)).toBe(VOLUME_PATH);
    expect(VOLUME_PATH).toStartWith("/data/agents/.restore/");
    expect(VOLUME_PATH).not.toBe(`/data/agents/${AGENT_ID}`);
    expect(() =>
      deriveRestoreStagingVolumePathV1(AGENT_ID.toUpperCase(), RESTORE_ATTEMPT_ID),
    ).toThrow(/canonical lowercase UUID/);
    expect(() => deriveRestoreStagingVolumePathV1(AGENT_ID, "not-a-uuid")).toThrow(
      /canonical lowercase UUID/,
    );
  });

  test("sends the exact V1 frame as bytes and returns a canonical non-secret receipt", async () => {
    class NonStringifiablePassphrase extends Uint8Array {
      override toString(): string {
        throw new Error("secret bytes must not be converted to a string");
      }
    }

    const passphrase = new NonStringifiablePassphrase(safePassphrase(0x61));
    const controller = new AbortController();
    let observedCommand = "";
    let observedFrame: Buffer | undefined;
    let frameBeforeReturn: Buffer | undefined;
    let observedSignal: AbortSignal | undefined;

    const result = await seedRestoreVolumeVaultPassphraseBytes({
      agentId: AGENT_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      passphrase,
      signal: controller.signal,
      execStdin: async (command, stdin, signal) => {
        observedCommand = command;
        observedFrame = stdin;
        frameBeforeReturn = Buffer.from(stdin);
        observedSignal = signal;
      },
    });

    const expectedCommand = buildVolumeVaultPassphraseCommand(
      VOLUME_PATH,
      passphrase.byteLength,
      REPLACEMENT_ATTEMPT_ID,
      [
        ...expectedSafeDirectoryProof("/data"),
        ...expectedSafeDirectoryProof("/data/agents"),
        ...expectedDirectoryPreparation(RESTORE_ROOT),
        ...expectedDirectoryPreparation(AGENT_ROOT),
        ...expectedDirectoryPreparation(VOLUME_PATH),
        ...expectedDirectoryPreparation(`${VOLUME_PATH}/eliza`),
      ],
    );
    const expectedFrame = Buffer.alloc(
      Buffer.byteLength(`${VOLUME_VAULT_STDIN_FRAME_VERSION} 64\n`) +
        passphrase.byteLength +
        Buffer.byteLength(`\n${VOLUME_VAULT_STDIN_FRAME_END}\n`),
    );
    let offset = expectedFrame.write(`${VOLUME_VAULT_STDIN_FRAME_VERSION} 64\n`, "utf8");
    expectedFrame.set(passphrase, offset);
    offset += passphrase.byteLength;
    expectedFrame.write(`\n${VOLUME_VAULT_STDIN_FRAME_END}\n`, offset, "utf8");

    expect(observedCommand).toBe(expectedCommand);
    expect(observedCommand.indexOf('test ! -e "$attempt_cancelled"')).toBeLessThan(
      observedCommand.indexOf("install -d"),
    );
    expect(observedCommand).not.toContain("a".repeat(64));
    expect(observedSignal).toBe(controller.signal);
    expect(Buffer.isBuffer(observedFrame)).toBe(true);
    expect(frameBeforeReturn).toEqual(expectedFrame);
    expect(observedFrame).toBeDefined();
    expect(allZero(observedFrame!)).toBe(true);
    expect(passphrase).toEqual(safePassphrase(0x61));

    const expectedReceipt = {
      format: AGENT_BACKUP_RESTORE_VAULT_VOLUME_SEED_RECEIPT_FORMAT,
      transport: VOLUME_VAULT_STDIN_FRAME_VERSION,
      pathDerivation: AGENT_BACKUP_RESTORE_STAGING_VOLUME_PATH_DERIVATION_V1,
      agentId: AGENT_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      volumePathSha256: sha256Utf8(VOLUME_PATH),
      commandSha256: sha256Utf8(expectedCommand),
      passphraseByteLength: 64,
      completed: true as const,
    };
    expect(result.receipt).toEqual(expectedReceipt);
    expect(result.receiptDigest).toBe(sha256Utf8(JSON.stringify(expectedReceipt)));
    expect(JSON.stringify(result)).not.toContain(VOLUME_PATH);
    expect(JSON.stringify(result)).not.toContain("a".repeat(64));
    expect(
      buildRestoreVolumeVaultSeedReceiptV1({
        agentId: AGENT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        passphraseByteLength: passphrase.byteLength,
      }),
    ).toEqual(result);
  });

  test("zeroizes the frame when the injected transport throws", async () => {
    const passphrase = safePassphrase(0x62);
    const failure = new Error("transport failed");
    let observedFrame: Buffer | undefined;

    await expect(
      seedRestoreVolumeVaultPassphraseBytes({
        agentId: AGENT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        passphrase,
        signal: new AbortController().signal,
        execStdin: async (_command, stdin) => {
          observedFrame = stdin;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(observedFrame).toBeDefined();
    expect(allZero(observedFrame!)).toBe(true);
    expect(passphrase).toEqual(safePassphrase(0x62));
  });

  test("keeps stdin stable through transport cancellation, then wipes it after settlement", async () => {
    const passphrase = safePassphrase(0x63);
    const controller = new AbortController();
    const abortReason = new Error("restore claim cancelled");
    let observedFrame: Buffer | undefined;
    let wasZeroInsideTransportAbort = false;

    const pending = seedRestoreVolumeVaultPassphraseBytes({
      agentId: AGENT_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
      passphrase,
      signal: controller.signal,
      execStdin: async (_command, stdin, signal) => {
        observedFrame = stdin;
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              wasZeroInsideTransportAbort = allZero(stdin);
              resolve();
            },
            { once: true },
          );
        });
      },
    });

    controller.abort(abortReason);
    await expect(pending).rejects.toBe(abortReason);
    expect(wasZeroInsideTransportAbort).toBe(false);
    expect(observedFrame).toBeDefined();
    expect(allZero(observedFrame!)).toBe(true);
    expect(passphrase).toEqual(safePassphrase(0x63));
  });

  test("does not invoke the transport for a pre-aborted signal or unsafe secret bytes", async () => {
    let calls = 0;
    const execStdin = async (): Promise<void> => {
      calls += 1;
    };
    const controller = new AbortController();
    const abortReason = new Error("already cancelled");
    controller.abort(abortReason);

    await expect(
      seedRestoreVolumeVaultPassphraseBytes({
        agentId: AGENT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        passphrase: safePassphrase(0x64),
        signal: controller.signal,
        execStdin,
      }),
    ).rejects.toBe(abortReason);

    for (const passphrase of [
      new Uint8Array(0),
      new Uint8Array(63).fill(0x65),
      new Uint8Array(65).fill(0x65),
      new Uint8Array(64).fill(0x20),
      Uint8Array.from([...new Uint8Array(63).fill(0x65), 0x7f]),
    ]) {
      await expect(
        seedRestoreVolumeVaultPassphraseBytes({
          agentId: AGENT_ID,
          restoreAttemptId: RESTORE_ATTEMPT_ID,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
          passphrase,
          signal: new AbortController().signal,
          execStdin,
        }),
      ).rejects.toThrow(/passphrase/);
    }
    expect(() =>
      buildRestoreVolumeVaultSeedReceiptV1({
        agentId: AGENT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        passphraseByteLength: 11,
      }),
    ).toThrow(/passphrase/);
    expect(AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES).toBe(64);
    expect(calls).toBe(0);
  });

  test("returns the same receipt digest for replay-equivalent non-secret metadata", async () => {
    const seed = async (passphrase: Uint8Array) =>
      seedRestoreVolumeVaultPassphraseBytes({
        agentId: AGENT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        passphrase,
        signal: new AbortController().signal,
        execStdin: async () => undefined,
      });

    const first = await seed(safePassphrase(0x66));
    const replay = await seed(safePassphrase(0x66));
    const sameLengthDifferentSecret = await seed(safePassphrase(0x67));

    expect(replay).toEqual(first);
    expect(sameLengthDifferentSecret).toEqual(first);
    expect(
      buildRestoreVolumeVaultSeedReceiptV1({
        agentId: AGENT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        replacementAttemptId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        passphraseByteLength: AGENT_BACKUP_RESTORE_VAULT_PASSPHRASE_BYTES,
      }).receiptDigest,
    ).not.toBe(first.receiptDigest);
  });

  test("pre-creates an absent volume and seeds it idempotently in one stdin command", async () => {
    const parent = mkdtempSync(join(tmpdir(), "eliza-restore-vault-seed-"));
    const relocatedDataRoot = join(parent, "data");
    const relocatedAgentsRoot = join(relocatedDataRoot, "agents");
    const relocatedRoot = join(relocatedAgentsRoot, ".restore");
    const relocatedControlRoot = join(parent, "replacement-attempts");
    const relocatedAgentRoot = join(relocatedRoot, AGENT_ID);
    const volumePath = join(relocatedAgentRoot, RESTORE_ATTEMPT_ID);
    const passphrase = safePassphrase(0x68);
    const bin = join(parent, "bin");
    mkdirSync(relocatedAgentsRoot, { recursive: true, mode: 0o700 });
    mkdirSync(bin, { mode: 0o700 });
    const fakeStat = join(bin, "stat");
    writeFileSync(
      fakeStat,
      '#!/bin/sh\ncase "$2" in "%u") printf 0 ;; "%a") if test -d "$4"; then printf 700; else printf 600; fi ;; "%h") printf 1 ;; "%d:%i") printf "1:1" ;; "%d:%i:%s:%y:%z") printf stable-fingerprint ;; *) exit 64 ;; esac\n',
      { mode: 0o700 },
    );
    chmodSync(fakeStat, 0o700);
    const relocatedExec = (command: string, stdin: Buffer, signal: AbortSignal) =>
      execLocalShell(
        command
          .replaceAll("/data", relocatedDataRoot)
          .replaceAll("/var/lib/eliza/replacement-attempts", relocatedControlRoot)
          // macOS does not ship Linux flock(1); static utility tests retain the
          // exact production command while this local filesystem test stubs it.
          .replace("command -v flock >/dev/null 2>&1", ":")
          .replace("flock -w 30 9", ":")
          .replaceAll("chmod 700 --", "chmod 700")
          .replaceAll("chmod 600 --", "chmod 600"),
        stdin,
        signal,
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
      );
    try {
      const first = await seedRestoreVolumeVaultPassphraseBytes({
        agentId: AGENT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        passphrase,
        signal: new AbortController().signal,
        execStdin: relocatedExec,
      });
      const replay = await seedRestoreVolumeVaultPassphraseBytes({
        agentId: AGENT_ID,
        restoreAttemptId: RESTORE_ATTEMPT_ID,
        replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
        passphrase,
        signal: new AbortController().signal,
        execStdin: relocatedExec,
      });

      expect(readFileSync(getVolumeVaultPassphrasePath(volumePath))).toEqual(
        Buffer.from(passphrase),
      );
      expect(statSync(getVolumeVaultPassphrasePath(volumePath)).mode & 0o777).toBe(0o600);
      expect(statSync(relocatedRoot).mode & 0o777).toBe(0o700);
      expect(statSync(relocatedAgentRoot).mode & 0o777).toBe(0o700);
      expect(statSync(volumePath).mode & 0o777).toBe(0o700);
      expect(statSync(join(volumePath, "eliza")).mode & 0o777).toBe(0o700);
      expect(statSync(join(volumePath, "eliza")).isDirectory()).toBe(true);
      expect(replay).toEqual(first);

      const symlinkAttemptPath = join(relocatedAgentRoot, SYMLINK_ATTEMPT_ID);
      const symlinkTarget = join(parent, "symlink-target");
      mkdirSync(symlinkTarget, { mode: 0o700 });
      symlinkSync(symlinkTarget, symlinkAttemptPath);
      await expect(
        seedRestoreVolumeVaultPassphraseBytes({
          agentId: AGENT_ID,
          restoreAttemptId: SYMLINK_ATTEMPT_ID,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
          passphrase,
          signal: new AbortController().signal,
          execStdin: relocatedExec,
        }),
      ).rejects.toMatchObject({ code: 45 });
      expect(readdirSync(symlinkTarget)).toEqual([]);

      rmSync(relocatedAgentsRoot, { recursive: true, force: true });
      const ancestorSymlinkTarget = join(parent, "ancestor-symlink-target");
      mkdirSync(ancestorSymlinkTarget, { mode: 0o700 });
      symlinkSync(ancestorSymlinkTarget, relocatedAgentsRoot);
      await expect(
        seedRestoreVolumeVaultPassphraseBytes({
          agentId: AGENT_ID,
          restoreAttemptId: RESTORE_ATTEMPT_ID,
          replacementAttemptId: REPLACEMENT_ATTEMPT_ID,
          passphrase,
          signal: new AbortController().signal,
          execStdin: relocatedExec,
        }),
      ).rejects.toMatchObject({ code: 45 });
      expect(readdirSync(ancestorSymlinkTarget)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
