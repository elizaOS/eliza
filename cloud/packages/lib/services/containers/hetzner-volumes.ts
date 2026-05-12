/**
 * Hetzner Cloud volume orchestration for stateful containers.
 *
 * Wraps Hetzner Cloud volume primitives with the operations the
 * container control plane actually needs:
 *
 *   - getOrCreateProjectVolume: idempotent provision of the volume that
 *     holds /data for a `(organizationId, projectName)` project.
 *   - attachToNode: attach + wait + format-if-needed + mount on the
 *     target Docker node, returning the host mount path.
 *   - detachFromNode: unmount + detach so the node can be drained.
 *   - deleteProjectVolume: hard-delete the underlying Hetzner volume.
 *
 * Hetzner Cloud volumes are network-attached and location-bound. They
 * can move between any Cloud-provisioned node in the same location, but
 * NOT across locations and NOT to auctioned/dedicated boxes.
 *
 * The mount path on the host is `/data/projects/<org>/<project>` — the
 * same path the local-host volume uses, so the container's bind-mount
 * (`-v <volume_path>:/data`) is identical regardless of backing.
 */

import type { DockerNode } from "@/db/schemas/docker-nodes";
import {
  getHetznerCloudClient,
  HetznerCloudError,
  type HetznerVolume,
  isHetznerCloudConfigured,
} from "@/lib/services/containers/hetzner-cloud-api";
import { DockerSSHClient } from "@/lib/services/docker-ssh";
import { logger } from "@/lib/utils/logger";

export interface ProjectVolumeKey {
  organizationId: string;
  projectName: string;
}

export interface AttachedVolume {
  /** Hetzner Cloud volume id. */
  volumeId: number;
  /** Hetzner location (e.g. "fsn1"). */
  location: string;
  /** Linux device path on the host (e.g. /dev/disk/by-id/scsi-0HC_Volume_1234). */
  devicePath: string;
  /** Mount point on the host (`/data/projects/<org>/<project>`). */
  mountPath: string;
}

const VOLUME_LABEL_SOURCE = "managed-by";
const VOLUME_LABEL_VALUE = "eliza-cloud";
const VOLUME_LABEL_PROJECT_KEY = "project-key";

/**
 * Generate the Hetzner volume name for a project key. Hetzner volume
 * names must be ≤63 chars, alphanumeric + dashes + dots + underscores.
 */
function deriveVolumeName(key: ProjectVolumeKey): string {
  const safe = `${key.organizationId}-${key.projectName}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 50);
  return `cloud-proj-${safe}`;
}

/**
 * Mount path on the host. Identical to the local-host volume path so
 * the container bind-mount stays the same.
 */
export function deriveProjectMountPath(key: ProjectVolumeKey): string {
  const safeOrg = key.organizationId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeProject = key.projectName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 64);
  return `/data/projects/${safeOrg}/${safeProject}`;
}

function projectKeyLabel(key: ProjectVolumeKey): string {
  // Hetzner labels are ≤63 chars and accept the same charset as DNS
  // labels. Hash-friendly form that survives validation.
  return `${key.organizationId}.${key.projectName}`.slice(0, 63);
}

export class HetznerVolumeService {
  private readonly api = getHetznerCloudClient();

  /**
   * Find the existing Hetzner volume for the project (by label), or
   * create one in the requested location. Idempotent — calling twice
   * returns the same volume.
   */
  async getOrCreateProjectVolume(
    key: ProjectVolumeKey,
    options: { sizeGb: number; location: string },
  ): Promise<HetznerVolume> {
    const label = projectKeyLabel(key);
    const existing = await this.api.listVolumes({
      label: { [VOLUME_LABEL_SOURCE]: VOLUME_LABEL_VALUE, [VOLUME_LABEL_PROJECT_KEY]: label },
    });
    if (existing.length > 1) {
      throw new HetznerCloudError(
        "invalid_input",
        `Multiple Hetzner volumes found for project ${label} — operator must reconcile.`,
      );
    }
    if (existing[0]) return existing[0];

    return this.api.createVolume({
      name: deriveVolumeName(key),
      sizeGb: options.sizeGb,
      location: options.location,
      format: "ext4",
      automount: false,
      labels: {
        [VOLUME_LABEL_SOURCE]: VOLUME_LABEL_VALUE,
        [VOLUME_LABEL_PROJECT_KEY]: label,
      },
    });
  }

  /**
   * Attach the volume to a Docker node, wait for the action to settle,
   * format the disk if it has no filesystem, and mount it at the
   * canonical project mount path. Returns the device + mount paths.
   *
   * The node MUST be a Hetzner Cloud server (has `hcloudServerId` in
   * its docker_nodes metadata) and MUST be in the same location as the
   * volume — otherwise Hetzner rejects the attach with 422.
   */
  async attachToNode(
    volumeId: number,
    node: DockerNode,
    key: ProjectVolumeKey,
  ): Promise<AttachedVolume> {
    const meta = (node.metadata ?? {}) as Record<string, unknown>;
    const hcloudServerId =
      typeof meta.hcloudServerId === "number" ? meta.hcloudServerId : undefined;
    if (!hcloudServerId) {
      throw new HetznerCloudError(
        "invalid_input",
        `Node ${node.node_id} is not a Hetzner Cloud server (no hcloudServerId in metadata).`,
      );
    }

    const beforeAttach = await this.api.getVolume(volumeId);
    if (!beforeAttach) {
      throw new HetznerCloudError("not_found", `Volume ${volumeId} not found`);
    }

    if (beforeAttach.server === null) {
      const action = await this.api.attachVolume(volumeId, hcloudServerId, false);
      await this.api.waitForAction(action.id);
    } else if (beforeAttach.server !== hcloudServerId) {
      // Already attached elsewhere — detach first, then re-attach.
      // Detach is also async; wait for it.
      const detach = await this.api.detachVolume(volumeId);
      await this.api.waitForAction(detach.id);
      const attach = await this.api.attachVolume(volumeId, hcloudServerId, false);
      await this.api.waitForAction(attach.id);
    }

    const refreshed = await this.api.getVolume(volumeId);
    if (!refreshed?.linux_device) {
      throw new HetznerCloudError(
        "transport_error",
        `Volume ${volumeId} attached but linux_device is missing — cannot mount`,
      );
    }

    const mountPath = deriveProjectMountPath(key);
    await this.formatAndMount(node, refreshed.linux_device, mountPath);

    return {
      volumeId,
      location: refreshed.location.name,
      devicePath: refreshed.linux_device,
      mountPath,
    };
  }

  /**
   * Unmount the volume on the node and detach it from the Hetzner Cloud
   * server. Safe to call when the volume is not currently attached.
   */
  async detachFromNode(volumeId: number, node: DockerNode, mountPath: string): Promise<void> {
    const ssh = DockerSSHClient.getClient(
      node.hostname,
      node.ssh_port ?? 22,
      node.host_key_fingerprint ?? undefined,
      node.ssh_user ?? "root",
    );
    // Best-effort unmount. If the path isn't mounted, umount returns
    // non-zero and we proceed anyway.
    await ssh.exec(`umount ${shellQuote(mountPath)} || true`, 30_000).catch((err) =>
      logger.warn(`[hcloud-volumes] unmount failed for ${mountPath} on ${node.node_id}`, {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    const current = await this.api.getVolume(volumeId);
    if (current && current.server !== null) {
      const action = await this.api.detachVolume(volumeId);
      await this.api.waitForAction(action.id);
    }
  }

  /**
   * Hard-delete a project's Hetzner volume. The volume must be
   * unattached. Loses all data — only the operator should call this
   * (e.g. on org delete or explicit purge_volume request).
   */
  async deleteProjectVolume(volumeId: number): Promise<void> {
    const current = await this.api.getVolume(volumeId);
    if (current && current.server !== null) {
      const detach = await this.api.detachVolume(volumeId);
      await this.api.waitForAction(detach.id);
    }
    await this.api.deleteVolume(volumeId);
  }

  /**
   * Run mkfs.ext4 if the device has no filesystem, then mount it at
   * `mountPath`. Idempotent — if the device is already an ext4 volume
   * with data, formatting is skipped (blkid confirms).
   */
  private async formatAndMount(
    node: DockerNode,
    devicePath: string,
    mountPath: string,
  ): Promise<void> {
    const ssh = DockerSSHClient.getClient(
      node.hostname,
      node.ssh_port ?? 22,
      node.host_key_fingerprint ?? undefined,
      node.ssh_user ?? "root",
    );

    // Wait briefly for the device node to appear after attach. udev
    // sometimes lags by a second or two.
    const waitScript = `for i in $(seq 1 30); do [ -b ${shellQuote(devicePath)} ] && exit 0; sleep 1; done; echo "device ${devicePath} did not appear" >&2; exit 1`;
    await ssh.exec(waitScript, 60_000);

    // Skip mkfs if the device already has a filesystem.
    const blkidOutput = await ssh
      .exec(`blkid -o value -s TYPE ${shellQuote(devicePath)} 2>/dev/null || true`, 15_000)
      .catch(() => "");
    if (!blkidOutput.trim()) {
      logger.info(`[hcloud-volumes] Formatting ${devicePath} as ext4 on ${node.node_id}`);
      await ssh.exec(`mkfs.ext4 -F -L cloud-data ${shellQuote(devicePath)}`, 5 * 60_000);
    }

    await ssh.exec(`mkdir -p ${shellQuote(mountPath)}`, 30_000);
    // Idempotent mount — if already mounted at the same path it returns
    // 32 ("already mounted"), which we tolerate.
    await ssh.exec(
      `mountpoint -q ${shellQuote(mountPath)} || mount -o noatime ${shellQuote(devicePath)} ${shellQuote(mountPath)}`,
      30_000,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

let cached: HetznerVolumeService | null = null;

export function getHetznerVolumeService(): HetznerVolumeService {
  if (!isHetznerCloudConfigured()) {
    throw new HetznerCloudError(
      "missing_token",
      "Hetzner Cloud volume orchestration requires HCLOUD_TOKEN.",
    );
  }
  if (!cached) cached = new HetznerVolumeService();
  return cached;
}

export function isHetznerVolumesAvailable(): boolean {
  return isHetznerCloudConfigured();
}
