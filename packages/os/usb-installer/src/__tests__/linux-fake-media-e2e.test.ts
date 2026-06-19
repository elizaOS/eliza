import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUsbInstallerHandler } from "../../server";
import {
  type ExecFileResult,
  LinuxUsbInstallerBackend,
} from "../backend/linux-backend";
import type { ElizaOsImage, RemovableDrive } from "../backend/types";

const linuxIt = process.platform === "linux" ? it : it.skip;

const previousRawWriteGate = process.env.ELIZAOS_USB_ENABLE_RAW_WRITE;

let cleanupPaths: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function request(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", "http://127.0.0.1:5174");
  return new Request(`http://127.0.0.1:3742${pathname}`, {
    ...init,
    headers,
  });
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

  await Promise.allSettled(
    cleanupPaths.map((targetPath) =>
      fs.rm(targetPath, { force: true, recursive: true }),
    ),
  );
  cleanupPaths = [];
});

describe("Linux USB installer fake-media E2E", () => {
  linuxIt(
    "plans and executes a guarded Linux write through the HTTP handler without touching a real disk",
    async () => {
      process.env.ELIZAOS_USB_ENABLE_RAW_WRITE = "1";

      const tempDir = await fs.mkdtemp(
        path.join(tmpdir(), "elizaos-usb-installer-e2e-"),
      );
      cleanupPaths.push(tempDir);

      const sourceBytes = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < sourceBytes.length; i += 1) {
        sourceBytes[i] = i % 251;
      }

      const targetPath = path.join(tempDir, "fake-usb-target.img");
      await fs.writeFile(targetPath, Buffer.alloc(sourceBytes.length, 0));

      const imageId = `fake-linux-e2e-${process.pid}-${Date.now()}`;
      cleanupPaths.push(path.join("/tmp/elizaos-installer", `${imageId}.iso`));

      const drive: RemovableDrive = {
        id: "fake-usb",
        name: "Fake elizaOS USB",
        devicePath: targetPath,
        sizeBytes: 16 * 1024 ** 3,
        bus: "virtual",
        platform: "linux",
        safety: "safe-removable",
      };

      const image: ElizaOsImage = {
        id: imageId,
        label: "elizaOS fake media test",
        version: "e2e",
        channel: "stable",
        architecture: "x86_64",
        buildId: "fake-linux-e2e",
        publishedAt: "2026-05-19T00:00:00.000Z",
        url: "file://fake-linux-e2e.iso",
        checksumSha256: sha256(sourceBytes),
        sizeBytes: sourceBytes.length,
        minUsbSizeBytes: sourceBytes.length,
        manifestVersion: 1,
      };

      class FakeMediaLinuxBackend extends LinuxUsbInstallerBackend {
        async listRemovableDrives(): Promise<RemovableDrive[]> {
          return [drive];
        }

        async listImages(): Promise<ElizaOsImage[]> {
          return [image];
        }
      }

      const backend = new FakeMediaLinuxBackend({
        findEscalator: async () => ({ command: "env", argsPrefix: [] }),
        execFile: async (
          command: string,
          args: readonly string[],
        ): Promise<ExecFileResult> => {
          if (command === "lsblk") {
            expect(args.at(-1)).toBe(targetPath);
            return {
              stdout: JSON.stringify({
                blockdevices: [
                  {
                    name: "fakeusb",
                    children: [{ name: "fakeusb1", mountpoint: null }],
                  },
                ],
              }),
              stderr: "",
            };
          }

          if (command === "sync") {
            return { stdout: "", stderr: "" };
          }

          throw new Error(`Unexpected fake-media command: ${command}`);
        },
        resolveImage: async (_image, imagePath, onProgress) => {
          await fs.mkdir(path.dirname(imagePath), { recursive: true });
          await fs.writeFile(imagePath, sourceBytes);
          onProgress(1);
        },
        heartbeatIntervalMs: 10,
        heartbeatStallMs: 10_000,
      });

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

      const writtenBytes = await fs.readFile(targetPath);
      expect(writtenBytes.length).toBe(sourceBytes.length);
      expect(sha256(writtenBytes)).toBe(image.checksumSha256);
      expect(Buffer.compare(writtenBytes, sourceBytes)).toBe(0);
    },
  );
});
