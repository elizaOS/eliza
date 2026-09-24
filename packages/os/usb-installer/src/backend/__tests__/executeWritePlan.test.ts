// Exercises USB installer backend safety and platform behavior.
import type { ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import {
  NoPrivilegeEscalatorError,
  UnmountFailedError,
  WriteIncompleteError,
} from "../errors";
import {
  type ExecFileResult,
  findPrivilegeEscalator,
  LinuxUsbInstallerBackend,
  type PrivilegeEscalator,
  writeCanonicalRawImageToLinuxDevice,
} from "../linux-backend";
import {
  createArtifactSignaturePayload,
  writeVerifiedRawImage,
} from "../raw-image-pipeline";
import type {
  ElizaOsImage,
  InstallerStepId,
  RemovableDrive,
  WritePlan,
} from "../types";

// --- shared fixtures -------------------------------------------------------

const IMAGE_SIZE = 1_000_000_000; // 1 GB

const drive: RemovableDrive = {
  id: "sdb",
  name: "Test USB",
  devicePath: "/dev/sdb",
  sizeBytes: 4 * 1024 ** 3,
  bus: "usb",
  platform: "linux",
  safety: "safe-removable",
};

const image: ElizaOsImage = {
  id: "test-image",
  label: "Test",
  version: "0.0.1",
  channel: "stable",
  architecture: "x86_64",
  buildId: "build",
  publishedAt: "2026-01-01T00:00:00Z",
  url: "https://example.com/x.iso",
  checksumSha256:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  sizeBytes: IMAGE_SIZE,
  minUsbSizeBytes: IMAGE_SIZE,
  manifestVersion: 1,
};

function makePlan(): WritePlan {
  return {
    request: {
      driveId: drive.id,
      imageId: image.id,
      dryRun: false,
      acknowledgeDataLoss: true,
    },
    drive,
    image,
    steps: [],
    privilegedWriteImplemented: true,
  };
}

const escalator: PrivilegeEscalator = { command: "pkexec", argsPrefix: [] };

// --- mock dd helper --------------------------------------------------------

interface FakeDd extends EventEmitter {
  stderr: EventEmitter;
  stdout: EventEmitter;
  /** Push a stderr line synchronously. */
  emitProgress(line: string): void;
  /** Resolve dd with a code. */
  finish(code: number): void;
}

function createFakeDd(): FakeDd {
  const ee = new EventEmitter() as FakeDd;
  ee.stderr = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.emitProgress = (line) => {
    ee.stderr.emit("data", Buffer.from(`${line}\n`));
  };
  ee.finish = (code) => {
    ee.emit("close", code);
  };
  return ee;
}

/**
 * Returns a spawn mock and a promise that resolves with the dd instance once
 * the backend actually calls `spawn`. Tests can `await spawned` before pushing
 * progress lines, avoiding races on the multi-await execute path.
 */
function deferredSpawn(): {
  spawn: () => ChildProcess;
  spawned: Promise<FakeDd>;
} {
  let resolveSpawn!: (dd: FakeDd) => void;
  const spawned = new Promise<FakeDd>((r) => {
    resolveSpawn = r;
  });
  return {
    spawn: () => {
      const dd = createFakeDd();
      resolveSpawn(dd);
      return dd as unknown as ChildProcess;
    },
    spawned,
  };
}

// lsblk JSON returning the drive with a mounted child partition
function lsblkChildJson(mounted: boolean): string {
  return JSON.stringify({
    blockdevices: [
      {
        name: "sdb",
        children: [
          {
            name: "sdb1",
            mountpoint: mounted ? "/mnt/usb" : null,
          },
        ],
      },
    ],
  });
}

interface MockExecCall {
  command: string;
  args: readonly string[];
}

interface ExecMockOptions {
  /** Map command -> handler that returns ExecFileResult or throws. */
  handlers?: Record<
    string,
    (args: readonly string[]) => Promise<ExecFileResult> | ExecFileResult
  >;
  /** All calls are appended here. */
  calls: MockExecCall[];
}

function makeExecMock(opts: ExecMockOptions) {
  return async (
    command: string,
    args: readonly string[],
  ): Promise<ExecFileResult> => {
    opts.calls.push({ command, args });
    const handler = opts.handlers?.[command];
    if (handler) return handler(args);
    return { stdout: "", stderr: "" };
  };
}

// --- tests -----------------------------------------------------------------

describe("LinuxUsbInstallerBackend.executeWritePlan", () => {
  it("cancels the real pipeline only after the privileged writer confirms termination", async () => {
    const keyPair = generateKeyPairSync("ed25519");
    const bytes = Buffer.from("canonical raw bytes".repeat(4096));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const compressed = Buffer.from("synthetic compressed input");
    const compressedDigest = createHash("sha256")
      .update(compressed)
      .digest("hex");
    const rawImage: ElizaOsImage = {
      ...image,
      url: "https://example.test/elizaos.raw.zst",
      signatureUrl: "https://example.test/elizaos.raw.zst.sig",
      format: "raw.zst",
      checksumSha256: compressedDigest,
      sha256Compressed: compressedDigest,
      sha256Expanded: digest,
      compressedSize: compressed.length,
      expandedSize: bytes.length,
      sizeBytes: compressed.length,
      minDeviceBytes: bytes.length,
      minUsbSizeBytes: bytes.length,
      product: "elizaOS",
      schemaVersion: 1,
      sequence: 1,
      expires: "2027-01-01T00:00:00.000Z",
    };
    const signature = sign(
      null,
      createArtifactSignaturePayload(rawImage),
      keyPair.privateKey,
    );
    const temporaryRoot = await fs.mkdtemp(
      path.join(tmpdir(), "eliza-cancel-production-test-"),
    );
    const controller = new AbortController();
    let childClosed = false;
    let terminationRequested = false;
    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    const spawn = (
      _command: string,
      _args: readonly string[],
      options?: import("node:child_process").SpawnOptions,
    ): ChildProcess => {
      expect(options?.detached).toBe(process.platform !== "win32");
      const child = new EventEmitter() as ChildProcess;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdin,
        stdout,
        stderr,
        kill: () => {
          if (!terminationRequested) {
            terminationRequested = true;
            setTimeout(() => {
              childClosed = true;
              child.emit("close", null, "SIGTERM");
            }, 30);
          }
          return true;
        },
      });
      resolveSpawned();
      return child;
    };
    const rawWriter: typeof writeVerifiedRawImage = (
      selectedImage,
      target,
      options = {},
    ) =>
      writeVerifiedRawImage(selectedImage, target, {
        ...options,
        publicKey: keyPair.publicKey,
        temporaryRoot,
        createDecompressor: () =>
          new Transform({
            transform(_chunk, _encoding, callback) {
              callback();
            },
            flush(callback) {
              this.push(bytes);
              callback();
            },
          }),
        fetcher: async (input) =>
          String(input).endsWith(".sig")
            ? new Response(Uint8Array.from(signature).buffer)
            : new Response(Uint8Array.from(compressed).buffer, {
                headers: { "content-length": String(compressed.length) },
              }),
      });

    try {
      const execution = writeCanonicalRawImageToLinuxDevice(
        rawImage,
        drive,
        escalator,
        spawn,
        makeExecMock({ calls: [] }),
        () => {},
        rawWriter,
        { signal: controller.signal },
      );
      await spawned;
      controller.abort(new Error("operator cancellation"));

      await expect(execution).rejects.toMatchObject({
        name: "WriteCancelledError",
        message: expect.stringContaining("Media is incomplete"),
      });
      expect(terminationRequested).toBe(true);
      expect(childClosed).toBe(true);
      await expect(fs.readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("streams privileged raw bytes and reads back the exact expanded length", async () => {
    const expanded = Buffer.from("expanded raw disk bytes");
    const written: Buffer[] = [];
    const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn = (command: string, args: readonly string[]): ChildProcess => {
      spawnCalls.push({ command, args });
      const process = new EventEmitter() as ChildProcess;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(process, {
        stdin,
        stdout,
        stderr,
        kill: () => true,
      });
      if (args.some((argument) => argument.startsWith("of="))) {
        stdin.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
        stdin.on("finish", () =>
          queueMicrotask(() => process.emit("close", 0)),
        );
      } else {
        queueMicrotask(() => {
          stdout.end(Buffer.concat(written));
          process.emit("close", 0);
        });
      }
      return process;
    };
    const execCalls: MockExecCall[] = [];
    const rawWriter = async (
      _image: ElizaOsImage,
      target: import("../raw-image-pipeline").RawImageTarget,
      options: import("../raw-image-pipeline").RawImagePipelineOptions = {},
    ) => {
      expect(options.signal).toBe(abortController.signal);
      await pipeline(Readable.from(expanded), target.openWriteStream());
      await target.sync();
      const readback: Buffer[] = [];
      for await (const chunk of target.openReadbackStream(expanded.length)) {
        readback.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(readback)).toEqual(expanded);
      return {
        targetStableId: target.stableId,
        compressedBytes: 1,
        expandedBytes: expanded.length,
        sha256Compressed: image.checksumSha256,
        sha256Expanded: image.checksumSha256,
        sha256Readback: image.checksumSha256,
        releaseKeyFingerprint: image.checksumSha256,
      };
    };
    const abortController = new AbortController();

    await writeCanonicalRawImageToLinuxDevice(
      image,
      drive,
      escalator,
      spawn,
      makeExecMock({ calls: execCalls }),
      () => {},
      rawWriter,
      { signal: abortController.signal },
    );

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]?.args).toContain("of=/dev/sdb");
    expect(spawnCalls[1]?.args).toContain(`count=${expanded.length}`);
    expect(spawnCalls[1]?.args).toContain("iflag=count_bytes");
    expect(execCalls).toContainEqual({
      command: "pkexec",
      args: ["sync", "/dev/sdb"],
    });
  });

  it("routes canonical raw.zst only through the verified streaming writer", async () => {
    const execCalls: MockExecCall[] = [];
    let streamed = false;
    const compressed = image.checksumSha256;
    const rawImage: ElizaOsImage = {
      ...image,
      url: "https://example.com/elizaos.raw.zst",
      signatureUrl: "https://example.com/elizaos.raw.zst.sig",
      format: "raw.zst",
      checksumSha256: compressed,
      sha256Compressed: compressed,
      sha256Expanded: "fedcba9876543210".repeat(4),
      compressedSize: IMAGE_SIZE,
      expandedSize: IMAGE_SIZE + 1,
      sizeBytes: IMAGE_SIZE,
      minDeviceBytes: IMAGE_SIZE + 1,
      minUsbSizeBytes: IMAGE_SIZE + 1,
    };
    const backend = new LinuxUsbInstallerBackend({
      execFile: makeExecMock({
        calls: execCalls,
        handlers: {
          lsblk: async () => ({ stdout: lsblkChildJson(false), stderr: "" }),
        },
      }),
      findEscalator: async () => escalator,
      resolveImage: async () => {
        throw new Error("legacy resolver must not run");
      },
      verifyChecksum: async () => {
        throw new Error("legacy checksum path must not run");
      },
      spawn: () => {
        throw new Error("legacy direct-dd path must not run");
      },
      writeCanonicalRawImage: async (selectedImage, selectedDrive) => {
        expect(selectedImage).toBe(rawImage);
        expect(selectedDrive).toBe(drive);
        streamed = true;
      },
    });
    const plan = { ...makePlan(), image: rawImage };

    await backend.executeWritePlan(plan, () => {});

    expect(streamed).toBe(true);
    expect(backend.canonicalRawZstdSupported).toBe(true);
  });

  it("Test 1: UnmountFailedError propagates and dd is never spawned", async () => {
    const execCalls: MockExecCall[] = [];
    let spawnCalled = false;

    const umountErr: Error & { code?: number; stderr?: string } = Object.assign(
      new Error("umount failed"),
      { code: 1, stderr: "umount: /dev/sdb1: target is busy" },
    );

    const execFile = makeExecMock({
      calls: execCalls,
      handlers: {
        lsblk: async () => ({ stdout: lsblkChildJson(true), stderr: "" }),
        umount: async () => {
          throw umountErr;
        },
      },
    });

    const backend = new LinuxUsbInstallerBackend({
      execFile,
      findEscalator: async () => escalator,
      resolveImage: async () => {},
      verifyChecksum: async () => {},
      spawn: () => {
        spawnCalled = true;
        return createFakeDd() as unknown as ChildProcess;
      },
    });

    await expect(
      backend.executeWritePlan(makePlan(), () => {}),
    ).rejects.toMatchObject({
      name: "UnmountFailedError",
      devicePath: "/dev/sdb1",
    });

    // Re-run to assert message + stderr capture
    try {
      await backend.executeWritePlan(makePlan(), () => {});
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnmountFailedError);
      const e = err as UnmountFailedError;
      expect(e.devicePath).toBe("/dev/sdb1");
      expect(e.stderr).toContain("target is busy");
      expect(e.message).toContain("/dev/sdb1");
      expect(e.message).toContain("target is busy");
    }

    expect(spawnCalled).toBe(false);
  });

  it("Test 2: umount exit code 32 / 'not mounted' is tolerated and dd runs", async () => {
    const execCalls: MockExecCall[] = [];
    const notMountedErr: Error & { code?: number; stderr?: string } =
      Object.assign(new Error("umount failed"), {
        code: 32,
        stderr: "umount: /dev/sdb1: not mounted",
      });

    const execFile = makeExecMock({
      calls: execCalls,
      handlers: {
        lsblk: async () => ({ stdout: lsblkChildJson(true), stderr: "" }),
        umount: async () => {
          throw notMountedErr;
        },
      },
    });

    const { spawn, spawned } = deferredSpawn();
    const backend = new LinuxUsbInstallerBackend({
      execFile,
      findEscalator: async () => escalator,
      resolveImage: async () => {},
      verifyChecksum: async () => {},
      spawn,
    });

    const runPromise = backend.executeWritePlan(makePlan(), () => {});
    const dd = await spawned;
    // dd writes full image, exits 0
    dd.emitProgress(`${IMAGE_SIZE} bytes (1.0 GB, 0.9 GiB) copied, 1 s`);
    dd.finish(0);
    await runPromise;

    // umount was attempted (and tolerated), dd was used
    expect(execCalls.some((c) => c.command === "umount")).toBe(true);
  });

  it("Test 3: WriteIncompleteError when bytes written < expected", async () => {
    const execCalls: MockExecCall[] = [];
    const execFile = makeExecMock({
      calls: execCalls,
      handlers: {
        lsblk: async () => ({ stdout: lsblkChildJson(false), stderr: "" }),
      },
    });

    const { spawn, spawned } = deferredSpawn();
    const backend = new LinuxUsbInstallerBackend({
      execFile,
      findEscalator: async () => escalator,
      resolveImage: async () => {},
      verifyChecksum: async () => {},
      spawn,
    });

    const runPromise = backend.executeWritePlan(makePlan(), () => {});
    const dd = await spawned;

    const partial = Math.floor(IMAGE_SIZE * 0.9);
    dd.emitProgress(`${Math.floor(IMAGE_SIZE * 0.5)} bytes copied, 1 s`);
    dd.emitProgress(`${partial} bytes copied, 2 s`);
    dd.finish(0);

    let caught: unknown;
    try {
      await runPromise;
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(WriteIncompleteError);
    const e = caught as WriteIncompleteError;
    expect(e.expectedBytes).toBe(IMAGE_SIZE);
    expect(e.actualBytes).toBe(partial);
    expect(e.message).toContain(String(IMAGE_SIZE));
    expect(e.message).toContain(String(partial));
  });

  it("Test 4: final progress(1.0) is emitted for 'write' on success", async () => {
    const execCalls: MockExecCall[] = [];
    const execFile = makeExecMock({
      calls: execCalls,
      handlers: {
        lsblk: async () => ({ stdout: lsblkChildJson(false), stderr: "" }),
      },
    });

    const { spawn, spawned } = deferredSpawn();
    const backend = new LinuxUsbInstallerBackend({
      execFile,
      findEscalator: async () => escalator,
      resolveImage: async () => {},
      verifyChecksum: async () => {},
      spawn,
    });

    const progress: Array<{ step: InstallerStepId; pct: number }> = [];
    const runPromise = backend.executeWritePlan(makePlan(), (step, pct) =>
      progress.push({ step, pct }),
    );
    const dd = await spawned;

    // Stream up to 99% (which the parser will clamp to 0.99), then exit 0
    // with a final summary line matching expected bytes.
    dd.emitProgress(`${Math.floor(IMAGE_SIZE * 0.5)} bytes copied, 1 s`);
    dd.emitProgress(`${Math.floor(IMAGE_SIZE * 0.99)} bytes copied, 2 s`);
    dd.emitProgress(`${IMAGE_SIZE} bytes (1.0 GB) copied, 3 s, 333 MB/s`);
    dd.finish(0);

    await runPromise;

    const writeCalls = progress.filter((p) => p.step === "write");
    expect(writeCalls.length).toBeGreaterThan(0);
    expect(writeCalls.at(-1)).toEqual({ step: "write", pct: 1 });
  });

  it("Test 5: dd buffered-output heartbeat re-emits last progress while stalled", async () => {
    const execCalls: MockExecCall[] = [];
    const execFile = makeExecMock({
      calls: execCalls,
      handlers: {
        lsblk: async () => ({ stdout: lsblkChildJson(false), stderr: "" }),
      },
    });

    const { spawn, spawned } = deferredSpawn();
    // Use very short real intervals so the test stays fast and doesn't need
    // fake timers (which conflict with awaiting the spawn deferred above).
    const HEARTBEAT_INTERVAL = 5;
    const HEARTBEAT_STALL = 20;
    const backend = new LinuxUsbInstallerBackend({
      execFile,
      findEscalator: async () => escalator,
      resolveImage: async () => {},
      verifyChecksum: async () => {},
      spawn,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL,
      heartbeatStallMs: HEARTBEAT_STALL,
    });

    const progress: Array<{ step: InstallerStepId; pct: number }> = [];
    const runPromise = backend.executeWritePlan(makePlan(), (step, pct) =>
      progress.push({ step, pct }),
    );

    const dd = await spawned;

    // Emit ONE progress line at ~50%.
    dd.emitProgress(`${Math.floor(IMAGE_SIZE * 0.5)} bytes copied, 1 s`);
    const writeBefore = progress.filter((p) => p.step === "write").length;

    // Wait long enough (>stall) for heartbeat to fire at least once.
    await new Promise((r) => setTimeout(r, HEARTBEAT_STALL * 4));

    const writeAfter = progress.filter((p) => p.step === "write").length;
    expect(writeAfter).toBeGreaterThan(writeBefore);

    // Cleanly finish so we don't leak intervals.
    dd.emitProgress(`${IMAGE_SIZE} bytes copied, 10 s`);
    dd.finish(0);
    await runPromise;
  });

  it("Test 6: NoPrivilegeEscalatorError aborts before umount or dd", async () => {
    const execCalls: MockExecCall[] = [];
    let spawnCalled = false;

    const execFile = makeExecMock({
      calls: execCalls,
      handlers: {
        lsblk: async () => ({ stdout: lsblkChildJson(true), stderr: "" }),
        umount: async () => ({ stdout: "", stderr: "" }),
      },
    });

    const backend = new LinuxUsbInstallerBackend({
      execFile,
      findEscalator: () =>
        findPrivilegeEscalator({} as NodeJS.ProcessEnv, {
          hasCommand: async () => false,
          sudoNonInteractiveOk: async () => false,
        }),
      resolveImage: async () => {},
      verifyChecksum: async () => {},
      spawn: () => {
        spawnCalled = true;
        return createFakeDd() as unknown as ChildProcess;
      },
    });

    await expect(
      backend.executeWritePlan(makePlan(), () => {}),
    ).rejects.toBeInstanceOf(NoPrivilegeEscalatorError);

    expect(spawnCalled).toBe(false);
  });
});
