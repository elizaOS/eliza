import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstallRecoveryRequiredError } from "./executor";
import { DurableFileInstallServiceState } from "./file-service-state";
import { createDiskExecutionIdentity } from "./planner";
import type { DiskInventory, InstallAuthorization } from "./types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function stateFixture(): Promise<{
  root: string;
  state: DurableFileInstallServiceState;
}> {
  // The service's topology check rejects symlinked ancestors by design. On
  // macOS os.tmpdir() sits under /var -> /private/var, so anchor the fixture
  // at the resolved real path; the production check stays strict.
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "elizaos-installer-service-"),
  );
  temporaryDirectories.push(root);
  await mkdir(join(root, "authorizations"), { mode: 0o700 });
  await mkdir(join(root, "targets"), { mode: 0o700 });
  return { root, state: new DurableFileInstallServiceState(root) };
}

function authorization(): InstallAuthorization {
  return {
    planId: "a".repeat(64),
    inventoryFingerprint: "b".repeat(64),
    ownerId: "local-owner-1000",
    issuedAt: "2026-08-26T01:55:00.000Z",
    expiresAt: "2026-08-26T02:05:00.000Z",
    nonce: "approval-123",
    credential: "secret-not-persisted",
  };
}

function aliasInventory(stableId: string): DiskInventory {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  return {
    stableId,
    path: `/dev/disk/by-id/${stableId}`,
    kernelDeviceIdentity: "8:0:42",
    hardwareIdentity: {
      serial: "Z4D3ABCD",
      wwn: "0x5000c50012345678",
      firmwarePath: "/sys/devices/pci0000:00/0000:00:17.0",
    },
    sizeBytes: 256 * gib,
    logicalSectorBytes: 4096,
    partitionTable: "none",
    bootAncestryResolved: true,
    currentBootSource: false,
    firmware: "uefi",
    partitions: [],
    freeExtents: [{ id: "free", startBytes: mib, endBytes: 255 * gib }],
  };
}

describe("durable installer root-service state", () => {
  it("durably consumes an owner nonce without persisting the credential", async () => {
    const { root, state } = await stateFixture();

    await expect(state.claim(authorization())).resolves.toBe(true);
    await expect(state.claim(authorization())).resolves.toBe(false);

    const records = await readdir(join(root, "authorizations"));
    expect(records).toHaveLength(1);
    const path = join(root, "authorizations", records[0] as string);
    const stats = await lstat(path);
    expect(stats.mode & 0o777).toBe(0o600);
    const persisted = await readFile(path, "utf8");
    expect(persisted).toContain('"nonce":"approval-123"');
    expect(persisted).not.toContain("secret-not-persisted");
  });

  it("serializes aliases and duplicate serials under one lock", async () => {
    const { root, state } = await stateFixture();
    const firstIdentity = createDiskExecutionIdentity(
      aliasInventory("wwn-0x5000c50012345678"),
    );
    const collision = aliasInventory("ata-Samsung_SSD_OTHER");
    collision.kernelDeviceIdentity = "8:32:99";
    collision.hardwareIdentity.wwn = "0x5000c50099999999";
    collision.hardwareIdentity.firmwarePath =
      "/sys/devices/pci0000:80/0000:80:01.0";
    const secondIdentity = createDiskExecutionIdentity(collision);
    expect(secondIdentity).toBe(firstIdentity);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = state.runExclusive(
      firstIdentity,
      "8:0:42",
      "a".repeat(64),
      async () => {
        await held;
        return "finished";
      },
    );
    while ((await readdir(join(root, "targets"))).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await expect(
      state.runExclusive(
        secondIdentity,
        "8:0:42",
        "b".repeat(64),
        async () => "impossible",
      ),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
    release?.();
    await expect(first).resolves.toBe("finished");
    expect(await readdir(join(root, "targets"))).toEqual([]);
  });

  it("retains the cross-plan target lock after an execution failure", async () => {
    const { root, state } = await stateFixture();

    await expect(
      state.runExclusive("c".repeat(64), "8:0:42", "a".repeat(64), async () => {
        throw new Error("uncertain privileged write");
      }),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);

    const locks = await readdir(join(root, "targets"));
    expect(locks).toHaveLength(1);
    await expect(
      state.runExclusive(
        "c".repeat(64),
        "8:0:99",
        "b".repeat(64),
        async () => "must-not-run",
      ),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("leaves an unowned or unsafe state topology unusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "elizaos-installer-unsafe-"));
    temporaryDirectories.push(root);
    const external = await mkdtemp(
      join(tmpdir(), "elizaos-installer-external-"),
    );
    temporaryDirectories.push(external);
    await mkdir(join(root, "targets"), { mode: 0o700 });
    await symlink(external, join(root, "authorizations"));
    const state = new DurableFileInstallServiceState(root);

    await expect(state.claim(authorization())).rejects.toBeInstanceOf(
      InstallRecoveryRequiredError,
    );
  });

  it("rejects a state root reached through a symbolic-link ancestor", async () => {
    const parent = await mkdtemp(join(tmpdir(), "elizaos-installer-ancestor-"));
    temporaryDirectories.push(parent);
    const real = join(parent, "real");
    const root = join(real, "state");
    await mkdir(real, { mode: 0o700 });
    await mkdir(root, { mode: 0o700 });
    await mkdir(join(root, "authorizations"), { mode: 0o700 });
    await mkdir(join(root, "targets"), { mode: 0o700 });
    const alias = join(parent, "alias");
    await symlink(real, alias);
    const state = new DurableFileInstallServiceState(join(alias, "state"));

    await expect(state.claim(authorization())).rejects.toBeInstanceOf(
      InstallRecoveryRequiredError,
    );
  });

  it("uses hashed filenames rather than caller-controlled paths", async () => {
    const { root, state } = await stateFixture();
    const value = authorization();
    value.ownerId = "../../root";
    value.nonce = "../escape";
    await state.claim(value);

    const expected = createHash("sha256")
      .update(`${value.ownerId}\0${value.nonce}`)
      .digest("hex");
    expect(await readdir(join(root, "authorizations"))).toEqual([
      `${expected}.json`,
    ]);
  });

  it("fails closed at the durable authorization quota", async () => {
    const { root } = await stateFixture();
    const state = new DurableFileInstallServiceState(root, {
      maxAuthorizationRecords: 2,
    });
    const first = authorization();
    const second = { ...authorization(), nonce: "approval-456" };
    const third = { ...authorization(), nonce: "approval-789" };

    await expect(state.claim(first)).resolves.toBe(true);
    await expect(state.claim(second)).resolves.toBe(true);
    await expect(state.claim(first)).resolves.toBe(false);
    await expect(state.claim(third)).rejects.toThrow(/capacity is exhausted/);
    expect(await readdir(join(root, "authorizations"))).toHaveLength(2);
  });

  it("rejects oversized persisted authorization fields", async () => {
    const { state } = await stateFixture();
    const value = authorization();
    value.nonce = "n".repeat(257);
    await expect(state.claim(value)).rejects.toThrow(/oversized/);
  });

  it("rejects a control-character kernel identity before persisting a lock", async () => {
    const { root, state } = await stateFixture();

    await expect(
      state.runExclusive(
        "c".repeat(64),
        "8:0\0forged",
        "a".repeat(64),
        async () => "must-not-run",
      ),
    ).rejects.toThrow(/identity is invalid/);
    expect(await readdir(join(root, "targets"))).toEqual([]);
  });
});
