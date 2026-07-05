/**
 * Error-policy pin for `HetznerVolumeService.attachToNode` (#13415).
 *
 * The load-bearing invariant: the filesystem probe in `formatAndMount` must
 * fail CLOSED. The `blkid ... || true` shell guard turns "no filesystem"
 * (blkid exit 2) into empty stdout — the ONLY legitimate empty result, which
 * is allowed to trigger a fresh `mkfs.ext4`. But an SSH/transport failure on
 * that probe must PROPAGATE, never be swallowed into "" — otherwise a failed
 * probe reads as "blank device" and formats a volume that may hold data.
 *
 * Deterministic harness: `./hetzner-cloud-api` and `../docker-ssh` are
 * mock.module'd so the real `attachToNode` runs against an in-memory Hetzner
 * client and a scripted SSH exec. No network, no ssh2.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { DockerNode } from "../../../db/schemas/docker-nodes";
import { HetznerCloudError } from "./hetzner-cloud-api";

type ExecFn = (cmd: string, timeoutMs?: number) => Promise<string>;

const HCLOUD_SERVER_ID = 424242;
const VOLUME_ID = 7777;

let sshExec: ExecFn;
let mkfsCommands: string[];
let mountCommands: string[];
let getVolumeCalls: number;

const fakeApi = {
  getVolume: async (_id: number) => {
    getVolumeCalls += 1;
    // First call = state before attach (unattached). Second = refreshed state
    // after the attach action settles (device now present).
    if (getVolumeCalls === 1) {
      return { id: VOLUME_ID, server: null, linux_device: null };
    }
    return {
      id: VOLUME_ID,
      server: HCLOUD_SERVER_ID,
      linux_device: "/dev/disk/by-id/scsi-0HC_Volume_7777",
      location: { name: "fsn1" },
    };
  },
  attachVolume: async (_v: number, _s: number, _a?: boolean) => ({ id: 101 }),
  detachVolume: async (_v: number) => ({ id: 102 }),
  waitForAction: async (_id: number) => ({ id: 101, status: "success" }),
};

const fakeSsh = { exec: (cmd: string, timeoutMs?: number) => sshExec(cmd, timeoutMs) };

mock.module("./hetzner-cloud-api", () => ({
  HetznerCloudError,
  getHetznerCloudClient: () => fakeApi,
  isHetznerCloudConfigured: () => true,
}));

mock.module("../docker-ssh", () => ({
  DockerSSHClient: { getClient: () => fakeSsh },
}));

const { HetznerVolumeService } = await import("./hetzner-volumes");

const node = {
  node_id: "node-abc",
  hostname: "10.0.0.5",
  ssh_port: 22,
  host_key_fingerprint: null,
  ssh_user: "root",
  metadata: { hcloudServerId: HCLOUD_SERVER_ID },
} as unknown as DockerNode;

const key = { organizationId: "org1", projectName: "proj1" };

/**
 * Route a scripted SSH command to a result. `blkid` is the branch under test:
 * caller supplies its outcome (empty stdout, a filesystem type, or a reject).
 */
function makeExec(blkid: () => Promise<string>): ExecFn {
  return async (cmd: string) => {
    if (cmd.includes("blkid")) return blkid();
    if (cmd.includes("mkfs.ext4")) {
      mkfsCommands.push(cmd);
      return "";
    }
    if (cmd.includes("mountpoint")) {
      mountCommands.push(cmd);
      return "";
    }
    // waitScript ([ -b ... ]) and mkdir -p both resolve cleanly.
    return "";
  };
}

describe("HetznerVolumeService.attachToNode filesystem probe (#13415)", () => {
  beforeEach(() => {
    mkfsCommands = [];
    mountCommands = [];
    getVolumeCalls = 0;
  });

  afterEach(() => {
    mock.restore();
  });

  it("designed-empty probe (no filesystem) formats then mounts", async () => {
    // blkid + `|| true` yields empty stdout: a genuinely blank device.
    sshExec = makeExec(async () => "");
    const svc = new HetznerVolumeService();

    const attached = await svc.attachToNode(VOLUME_ID, node, key);

    expect(mkfsCommands.length).toBe(1);
    expect(mountCommands.length).toBe(1);
    expect(attached.volumeId).toBe(VOLUME_ID);
    expect(attached.location).toBe("fsn1");
    expect(attached.mountPath).toBe("/data/projects/org1/proj1");
  });

  it("existing filesystem (non-empty probe) skips mkfs but still mounts", async () => {
    sshExec = makeExec(async () => "ext4\n");
    const svc = new HetznerVolumeService();

    const attached = await svc.attachToNode(VOLUME_ID, node, key);

    expect(mkfsCommands.length).toBe(0);
    expect(mountCommands.length).toBe(1);
    expect(attached.devicePath).toContain("scsi-0HC_Volume_7777");
  });

  it("SSH failure on the probe PROPAGATES and never triggers a destructive mkfs", async () => {
    // A transport/exec failure must not be swallowed into "" — that would read
    // as "blank device" and format a volume that may hold data.
    const probeError = new Error("ssh channel closed unexpectedly");
    sshExec = makeExec(async () => {
      throw probeError;
    });
    const svc = new HetznerVolumeService();

    await expect(svc.attachToNode(VOLUME_ID, node, key)).rejects.toThrow(
      "ssh channel closed unexpectedly",
    );
    // The critical assertion: the failed probe did NOT fall through to mkfs.
    expect(mkfsCommands.length).toBe(0);
    expect(mountCommands.length).toBe(0);
  });
});
