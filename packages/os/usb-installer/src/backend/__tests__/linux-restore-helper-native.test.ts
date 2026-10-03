import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeLinuxRestoreHelperRequest } from "../linux-restore-helper-protocol";

const source = resolve(
  import.meta.dirname,
  "../../../native/linux-restore-helper.c",
);
function currentBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "ascii").trim();
}

function compileHelper(): { binary: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "elizaos-restore-helper-"));
  const binary = join(directory, "linux-restore-helper");
  execFileSync(
    "cc",
    [
      "-std=c17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Wconversion",
      "-Wshadow",
      "-Wformat=2",
      "-o",
      binary,
      source,
    ],
    { killSignal: "SIGKILL", timeout: 15_000 },
  );
  return { binary, directory };
}

describe.runIf(process.platform === "linux")(
  "native Linux Restore identity gate",
  () => {
    let helper: string;
    let helperDirectory: string;

    beforeAll(() => {
      const compiled = compileHelper();
      helper = compiled.binary;
      helperDirectory = compiled.directory;
    }, 20_000);

    afterAll(() => {
      rmSync(helperDirectory, { recursive: true, force: true });
    });

    it("compiles warning-free and rejects malformed or oversized IPC", () => {
      for (const request of [Buffer.alloc(0), Buffer.alloc(2049, 0x41)]) {
        const result = spawnSync(helper, [], { input: request });
        expect(result.status).toBe(2);
        expect(result.stdout.toString()).toContain("code=INVALID_REQUEST\n");
      }
    });

    it("never reaches a success response without privilege and trusted authorization", () => {
      const request = encodeLinuxRestoreHelperRequest({
        planId: "0123456789abcdef0123456789abcdef",
        bootId: currentBootId(),
        devicePath: "/dev/sdz",
        expectedMajor: "8",
        expectedMinor: "240",
        expectedDiskseq: "51",
        expectedSizeBytes: "68719476736",
        partitionNumber: "1",
        filesystem: "exfat",
        label: "ELIZAOS-USB",
        acknowledgement: "ERASE",
      });
      const result = spawnSync(helper, [], { input: request });
      const response = result.stdout.toString();

      expect(result.status).not.toBe(0);
      expect(response).not.toContain("status=ok");
      expect(response).toMatch(
        /code=(PRIVILEGE_REQUIRED|STATE_UNAVAILABLE|PLAN_NOT_AUTHORIZED)\n/,
      );
    });

    it("rejects a digest-bound request from another boot before privilege", () => {
      const request = encodeLinuxRestoreHelperRequest({
        planId: "0123456789abcdef0123456789abcdef",
        bootId: "00000000-0000-0000-0000-000000000001",
        devicePath: "/dev/sdz",
        expectedMajor: "8",
        expectedMinor: "240",
        expectedDiskseq: "51",
        expectedSizeBytes: "68719476736",
        partitionNumber: "1",
        filesystem: "exfat",
        label: "ELIZAOS-USB",
        acknowledgement: "ERASE",
      });
      const result = spawnSync(helper, [], { input: request });

      expect(result.status).toBe(3);
      expect(result.stdout.toString()).toContain("code=BOOT_ID_MISMATCH\n");
    });

    it("contains no shell invocation or compiled destructive utility", () => {
      const nativeSource = readFileSync(source, "utf8");
      expect(nativeSource).not.toMatch(/\b(system|popen)\s*\(/);
      expect(nativeSource).not.toMatch(/exec(?:l|v|ve|vp)\s*\(/);
      expect(nativeSource).not.toContain("/usr/sbin/wipefs");
      expect(nativeSource).not.toContain("/usr/sbin/sfdisk");
      expect(nativeSource).not.toContain("mkfs");
      expect(nativeSource).toContain("/proc/self/fd/<n>");
      expect(nativeSource).toContain("(void)consume_authorized_plan;");
      expect(nativeSource.match(/consume_authorized_plan\(/g)).toHaveLength(1);
      expect(nativeSource).toContain(
        "open(partition_path, O_RDWR | O_CLOEXEC | O_NOFOLLOW);",
      );
      expect(nativeSource).not.toContain(
        "open(partition_path, O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_EXCL)",
      );
    });
  },
);
