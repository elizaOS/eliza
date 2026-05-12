/**
 * Cloud-init bootstrap for newly provisioned Hetzner Cloud nodes.
 *
 * Generated on demand and passed as `user_data` when calling
 * `HetznerCloudClient.createServer()`. The script:
 *   1. Installs Docker (official `get.docker.com` script).
 *   2. Creates the shared bridge network (`containers-isolated` by default).
 *   3. Adds the control plane's deploy SSH key to /root/.ssh/authorized_keys.
 *   4. Pre-creates the per-node volume root /data/containers/.
 *   5. Optionally pre-pulls a list of images so the first deployment on
 *      this node has warm cache (huge UX win for multi-GiB agent images).
 *   6. Pings a self-registration endpoint on the control plane so the
 *      node lands in the docker_nodes table without operator action.
 *
 * The script is yaml-shaped (cloud-init User-Data MIME), so it must keep
 * indentation consistent and YAML-special chars escaped. Returned as
 * plain text — Hetzner accepts it under 32 KiB.
 */

import { containersEnv } from "@/lib/config/containers-env";
import { validateDockerPlatform } from "@/lib/services/docker-sandbox-utils";

export interface NodeBootstrapInput {
  /** Logical node id (must match what the control plane will register). */
  nodeId: string;
  /**
   * Public SSH authorized_key line (`ssh-ed25519 AAAA... root@control`).
   * The node accepts this key for root SSH so the control plane can
   * exec docker commands. Required.
   */
  controlPlanePublicKey: string;
  /**
   * Optional self-registration callback URL. After Docker is up the node
   * POSTs `{ nodeId, hostname, capacity }` here so the control plane
   * inserts a row in docker_nodes automatically. If omitted, an operator
   * must call POST /api/v1/admin/docker-nodes manually.
   */
  registrationUrl?: string;
  /** Shared secret expected by the registration callback. */
  registrationSecret?: string;
  /** Images to pre-pull on the new node so first deployments are fast. */
  prePullImages?: string[];
  /** Optional Docker image platform used for pre-pulls. */
  prePullPlatform?: string;
  /** Default capacity advertised at registration. */
  capacity?: number;
}

/**
 * Build the cloud-init user-data script for a new container node.
 * Returned as a plain string suitable for HetznerCloudClient.createServer({ userData }).
 */
export function buildContainerNodeUserData(input: NodeBootstrapInput): string {
  const network = containersEnv.dockerNetwork();
  const capacity = input.capacity ?? 8;
  const prePull = input.prePullImages ?? [containersEnv.defaultAgentImage()];
  const prePullPlatform = input.prePullPlatform ?? containersEnv.defaultAgentImagePlatform();
  if (prePullPlatform) validateDockerPlatform(prePullPlatform);
  const prePullPlatformFlag = prePullPlatform
    ? ` --platform '${sanitizeShellSingleQuoted(prePullPlatform)}'`
    : "";
  const sshKey = sanitizeShellSingleQuoted(input.controlPlanePublicKey.trim());
  const nodeId = sanitizeShellSingleQuoted(input.nodeId);
  const registerUrl = input.registrationUrl ? sanitizeShellSingleQuoted(input.registrationUrl) : "";
  const registerSecret = input.registrationSecret
    ? sanitizeShellSingleQuoted(input.registrationSecret)
    : "";

  const prePullCommands = prePull
    .filter((image) => image && image.length > 0)
    .map(
      (image) =>
        `  - docker pull${prePullPlatformFlag} '${sanitizeShellSingleQuoted(image)}' || true`,
    )
    .join("\n");

  // The registration call is best-effort; the admin operator can re-run
  // the curl command from the host if it fails at boot (e.g. control
  // plane DNS not yet resolvable from the new VPS).
  const registerSection = input.registrationUrl
    ? `
  - |
    HOSTNAME=$(hostname -f 2>/dev/null || hostname)
    PUBLIC_IP=$(curl -fsS ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    PAYLOAD=$(printf '{"nodeId":"%s","hostname":"%s","capacity":%d}' '${nodeId}' "$PUBLIC_IP" ${capacity})
    curl -fsS -X POST '${registerUrl}' \\
      -H 'Content-Type: application/json' \\
      ${registerSecret ? `-H 'X-Bootstrap-Secret: ${registerSecret}'` : ""} \\
      --data "$PAYLOAD" || echo '[bootstrap] self-registration failed; register manually via admin API'`
    : "";

  return `#cloud-config
package_update: true
package_upgrade: false
ssh_pwauth: false
chpasswd:
  expire: false

write_files:
  - path: /root/.ssh/authorized_keys
    permissions: '0600'
    content: |
      ${sshKey}
    append: true

runcmd:
  - chage -M 99999 -E -1 root || true
  - mkdir -p /data/containers /data/agents
  - chmod 0700 /data/containers /data/agents
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - docker network inspect '${sanitizeShellSingleQuoted(network)}' >/dev/null 2>&1 || docker network create --driver bridge '${sanitizeShellSingleQuoted(network)}'
${prePullCommands}${registerSection}
`;
}

/**
 * Conservative shell-quoting for values interpolated inside single-quoted
 * shell strings within cloud-init. Escapes single quotes by close-and-open;
 * rejects newlines because cloud-init YAML can't carry them inside this
 * context without re-templating.
 */
function sanitizeShellSingleQuoted(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("[node-bootstrap] value contains newline characters; cannot embed in script");
  }
  return value.replace(/'/g, `'"'"'`);
}
