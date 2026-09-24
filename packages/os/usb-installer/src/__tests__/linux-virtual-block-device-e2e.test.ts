// Exercises USB installer server and dry-run application behavior.
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createZstdCompress } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createUsbInstallerHandler } from "../../server";
import { LinuxUsbInstallerBackend } from "../backend/linux-backend";
import { createArtifactSignaturePayload } from "../backend/raw-image-pipeline";
import type { ElizaOsImage, RemovableDrive } from "../backend/types";

const execFileAsync = promisify(execFile);
const scsiDebugIt =
  process.platform === "linux" &&
  process.env.ELIZAOS_USB_TEST_SCSI_DEBUG === "1"
    ? it
    : it.skip;

const PRODUCT = "ELIZAUSBTEST";
const VIRTUAL_USB_SIZE = 64 * 1024 ** 2;
const IMAGE_SIZE = 4 * 1024 ** 2;
const previousRawWriteGate = process.env.ELIZAOS_USB_ENABLE_RAW_WRITE;
const previousReleaseKey =
  process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64;
const previousReleaseKeyFingerprint =
  process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256;
const originalFetch = globalThis.fetch;

let loadedScsiDebug = false;
let cleanupPaths: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function zstd(bytes: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from(bytes),
    createZstdCompress(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(chunks);
}

function request(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", "http://127.0.0.1:5174");
  return new Request(`http://127.0.0.1:3742${pathname}`, {
    ...init,
    headers,
  });
}

async function commandSucceeds(
  command: string,
  args: readonly string[] = [],
): Promise<boolean> {
  try {
    await execFileAsync(command, [...args]);
    return true;
  } catch {
    return false;
  }
}

async function scsiDebugModuleAvailable(): Promise<boolean> {
  return commandSucceeds("modinfo", ["scsi_debug"]);
}

async function loadVirtualUsbDisk(): Promise<void> {
  const alreadyLoaded = await commandSucceeds("sh", [
    "-c",
    "lsmod | grep -q '^scsi_debug\\b'",
  ]);
  if (alreadyLoaded) {
    throw new Error(
      "scsi_debug is already loaded; refusing to reuse an existing virtual disk.",
    );
  }

  await execFileAsync("sudo", ["-n", "true"]);
  await execFileAsync("sudo", [
    "-n",
    "modprobe",
    "scsi_debug",
    "dev_size_mb=64",
    "removable=1",
    "add_host=1",
    "inq_vendor=ELIZAOS",
    `inq_product=${PRODUCT}`,
  ]);
  loadedScsiDebug = true;
}

async function unloadVirtualUsbDisk(): Promise<void> {
  if (!loadedScsiDebug) {
    return;
  }

  await execFileAsync("sync", []);
  await deleteVirtualUsbDevices();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await execFileAsync("sudo", ["-n", "modprobe", "-r", "scsi_debug"]);
      loadedScsiDebug = false;
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  loadedScsiDebug = false;
}

async function deleteVirtualUsbDevices(): Promise<void> {
  const blockDevices = await fs.readdir("/sys/block");
  for (const blockName of blockDevices) {
    if (!/^sd[a-z]+$/.test(blockName)) {
      continue;
    }

    const modelPath = `/sys/block/${blockName}/device/model`;
    let model: string;
    try {
      model = (await fs.readFile(modelPath, "utf8")).trim();
    } catch {
      continue;
    }

    if (model !== PRODUCT) {
      continue;
    }

    await execFileAsync("sudo", [
      "-n",
      "sh",
      "-c",
      `echo 1 > /sys/block/${blockName}/device/delete`,
    ]);
  }
}

async function findVirtualDrive(
  backend: LinuxUsbInstallerBackend,
): Promise<RemovableDrive> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const drives = await backend.listRemovableDrives();
    const drive = drives.find(
      (candidate) =>
        candidate.name === PRODUCT &&
        candidate.sizeBytes === VIRTUAL_USB_SIZE &&
        candidate.safety === "safe-removable",
    );
    if (drive) {
      return drive;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Virtual ${PRODUCT} removable disk did not appear.`);
}

async function assertVirtualDriveIdentity(drive: RemovableDrive) {
  const blockName = path.basename(drive.devicePath);
  const model = (
    await fs.readFile(`/sys/block/${blockName}/device/model`, "utf8")
  ).trim();
  const removable = (
    await fs.readFile(`/sys/block/${blockName}/removable`, "utf8")
  ).trim();

  expect(model).toBe(PRODUCT);
  expect(removable).toBe("1");
  expect(drive.name).toBe(PRODUCT);
  expect(drive.sizeBytes).toBe(VIRTUAL_USB_SIZE);
  expect(drive.safety).toBe("safe-removable");
  expect(drive.devicePath).toMatch(/^\/dev\/sd[a-z]+$/);
}

async function collectServerEvents(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      expect(chunk.startsWith("data: ")).toBe(true);
      return JSON.parse(chunk.slice("data: ".length)) as unknown;
    });
}

afterEach(async () => {
  if (previousRawWriteGate === undefined) {
    delete process.env.ELIZAOS_USB_ENABLE_RAW_WRITE;
  } else {
    process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = previousRawWriteGate;
  }
  if (previousReleaseKey === undefined) {
    delete process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64;
  } else {
    process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64 =
      previousReleaseKey;
  }
  if (previousReleaseKeyFingerprint === undefined) {
    delete process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256;
  } else {
    process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256 =
      previousReleaseKeyFingerprint;
  }
  globalThis.fetch = originalFetch;

  await Promise.allSettled(
    cleanupPaths.map((targetPath) =>
      fs.rm(targetPath, { force: true, recursive: true }),
    ),
  );
  cleanupPaths = [];

  await unloadVirtualUsbDisk();
});

describe("Linux USB installer virtual block-device E2E", () => {
  scsiDebugIt(
    "writes and reads back a signed raw.zst image on a disposable scsi_debug device",
    async () => {
      if (!(await scsiDebugModuleAvailable())) {
        throw new Error(
          "scsi_debug kernel module is unavailable; required virtual block-device proof cannot run.",
        );
      }

      process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";

      const tempDir = await fs.mkdtemp(
        path.join(tmpdir(), "elizaos-usb-virtual-block-e2e-"),
      );
      cleanupPaths.push(tempDir);

      const sourceBytes = Buffer.alloc(IMAGE_SIZE);
      for (let i = 0; i < sourceBytes.length; i += 1) {
        sourceBytes[i] = (i * 17 + 23) % 251;
      }
      const compressedBytes = await zstd(sourceBytes);
      const keyPair = generateKeyPairSync("ed25519");
      const publicKeyDer = keyPair.publicKey.export({
        type: "spki",
        format: "der",
      });
      process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64 =
        publicKeyDer.toString("base64");
      process.env.ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256 =
        sha256(publicKeyDer);

      const imageId = `virtual-block-e2e-${process.pid}-${Date.now()}`;

      const image: ElizaOsImage = {
        id: imageId,
        label: "elizaOS virtual block-device test",
        version: "e2e",
        channel: "stable",
        architecture: "x86_64",
        buildId: "virtual-block-e2e",
        publishedAt: "2026-05-19T00:00:00.000Z",
        url: "https://virtual-block.test/elizaos.raw.zst",
        signatureUrl: "https://virtual-block.test/elizaos.raw.zst.sig",
        checksumSha256: sha256(compressedBytes),
        sizeBytes: compressedBytes.length,
        minUsbSizeBytes: sourceBytes.length,
        manifestVersion: 1,
        schemaVersion: 1,
        product: "elizaOS",
        sequence: 1,
        expires: "2099-01-01T00:00:00.000Z",
        compressedSize: compressedBytes.length,
        expandedSize: sourceBytes.length,
        sha256Compressed: sha256(compressedBytes),
        sha256Expanded: sha256(sourceBytes),
        minDeviceBytes: sourceBytes.length,
        format: "raw.zst",
      };
      const signature = sign(
        null,
        createArtifactSignaturePayload(image),
        keyPair.privateKey,
      );
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request) => {
          const url = String(input);
          if (url === image.signatureUrl) {
            return new Response(Uint8Array.from(signature).buffer);
          }
          if (url === image.url) {
            return new Response(Uint8Array.from(compressedBytes).buffer, {
              headers: { "content-length": String(compressedBytes.length) },
            });
          }
          throw new Error(`Unexpected virtual block-device fetch: ${url}`);
        },
        { preconnect: originalFetch.preconnect },
      );

      class VirtualBlockLinuxBackend extends LinuxUsbInstallerBackend {
        async listImages(): Promise<ElizaOsImage[]> {
          return [image];
        }
      }

      const backend = new VirtualBlockLinuxBackend({
        findEscalator: async () => ({ command: "sudo", argsPrefix: ["-n"] }),
        heartbeatIntervalMs: 50,
        heartbeatStallMs: 10_000,
      });

      await loadVirtualUsbDisk();
      const drive = await findVirtualDrive(backend);
      await assertVirtualDriveIdentity(drive);

      const handler = createUsbInstallerHandler(backend);
      const planRes = await handler(
        request("/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            driveId: drive.id,
            imageId: image.id,
            dryRun: false,
            acknowledgeDataLoss: true,
          }),
        }),
      );

      expect(planRes.status).toBe(200);
      const plan = (await planRes.json()) as { planId?: string };
      expect(plan.planId).toEqual(expect.any(String));

      const executeRes = await handler(
        request("/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ planId: plan.planId }),
        }),
      );

      expect(executeRes.status).toBe(200);
      const events = await collectServerEvents(executeRes);
      expect(events).toContainEqual({ stepId: "write", progress: 1 });
      expect(events).toContainEqual({ stepId: "complete", progress: 1 });
      expect(events).toContainEqual({ done: true });

      const readbackPath = path.join(tempDir, "readback.img");
      await execFileAsync("sudo", [
        "-n",
        "dd",
        `if=${drive.devicePath}`,
        `of=${readbackPath}`,
        "bs=1M",
        `count=${IMAGE_SIZE / 1024 ** 2}`,
        "status=none",
      ]);

      const readback = await fs.readFile(readbackPath);
      expect(readback.length).toBe(sourceBytes.length);
      expect(sha256(readback)).toBe(image.sha256Expanded);
      expect(Buffer.compare(readback, sourceBytes)).toBe(0);
    },
    30_000,
  );
});
