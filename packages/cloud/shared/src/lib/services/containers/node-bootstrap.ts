/**
 * Cloud-init bootstrap for newly provisioned Hetzner Cloud nodes.
 *
 * Generated on demand and passed as `user_data` when calling
 * `HetznerCloudClient.createServer()`. The script:
 *   1. Installs Docker (official `get.docker.com` script).
 *   2. Creates the shared bridge network (`containers-isolated` by default).
 *   3. Adds the control plane's deploy SSH key to /root/.ssh/authorized_keys.
 *   4. Pre-creates the per-node volume root /data/containers/.
 *   5. Installs the local-embedding sidecar (see `embedding-sidecar.ts`):
 *      `--restart always` supervises it, and the health loop probes/repairs
 *      it, so it is never a hand-installed one-off again.
 *   6. Optionally pre-pulls a list of images so the first deployment on
 *      this node has warm cache (huge UX win for multi-GiB agent images).
 *   7. Pings a self-registration endpoint on the control plane so the
 *      node lands in the docker_nodes table without operator action.
 *
 * The script is yaml-shaped (cloud-init User-Data MIME), so it must keep
 * indentation consistent and YAML-special chars escaped. Returned as
 * plain text — Hetzner accepts it under 32 KiB.
 */

import { containersEnv } from "../../config/containers-env";
import { CLOUD_METADATA_IP } from "../app-firewall-utils";
import { validateDockerPlatform } from "../docker-sandbox-utils";
import { buildEnsureEmbeddingSidecarCmd } from "./embedding-sidecar";
import { getImageRegistryHost } from "./hetzner-client/registry";

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

  const prePullImages = prePull.filter((image) => image && image.length > 0);

  // Ensure deterministic registry access before pre-pulling. The managed agent
  // image is public, so a node must NOT carry a stale stored ghcr credential
  // (an expired token in /root/.docker/config.json overrides anonymous access
  // and the pull fails with `denied`). Mirror `ensureRegistryAccess`:
  //   - no token configured → `docker logout <host>` clears any stale cred.
  //   - token configured     → `docker login <host>` writes a fresh cred.
  // Hosts are derived from the pre-pull images (ghcr.io for the default image).
  const registryHosts = Array.from(
    new Set(
      prePullImages
        .map((image) => getImageRegistryHost(image))
        .filter((host): host is string => host !== null),
    ),
  );
  const registryToken = containersEnv.registryToken();
  const registryUsername = containersEnv.registryUsername();
  const registryAccessCommands = registryHosts
    .map((host) => {
      const quotedHost = sanitizeShellSingleQuoted(host);
      if (registryToken && registryUsername) {
        return `  - printf %s '${sanitizeShellSingleQuoted(registryToken)}' | docker login '${quotedHost}' -u '${sanitizeShellSingleQuoted(registryUsername)}' --password-stdin >/dev/null 2>&1 || true`;
      }
      return `  - docker logout '${quotedHost}' >/dev/null 2>&1 || true`;
    })
    .join("\n");

  const prePullCommands = prePullImages
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
    HOST_KEY_FINGERPRINT=$(ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | awk '{print $2}')
    if [ -z "$HOST_KEY_FINGERPRINT" ]; then
      HOST_KEY_FINGERPRINT=$(ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_rsa_key.pub 2>/dev/null | awk '{print $2}')
    fi
    if [ -z "$HOST_KEY_FINGERPRINT" ]; then
      echo '[bootstrap] host key fingerprint unavailable; refusing self-registration'
      exit 1
    fi
    MEM_TOTAL_MB=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo 2>/dev/null)
    # Omitted rather than sent as 0 when unreadable: the callback rejects a
    # zero and would fail the whole registration over a missing hint.
    VCPU_COUNT=$(nproc 2>/dev/null)
    MEM_FIELD=""
    CPU_FIELD=""
    if [ -n "$VCPU_COUNT" ] && [ "$VCPU_COUNT" -gt 0 ] 2>/dev/null; then
      CPU_FIELD=$(printf '"vCpuCount":%d,' "$VCPU_COUNT")
    fi
    if [ -n "$MEM_TOTAL_MB" ] && [ "$MEM_TOTAL_MB" -gt 0 ] 2>/dev/null; then
      MEM_FIELD=$(printf '"memTotalMb":%d,' "$MEM_TOTAL_MB")
    fi
    PAYLOAD=$(printf '{"nodeId":"%s","hostname":"%s","capacity":%d,%s%s"sshPort":22,"sshUser":"root","hostKeyFingerprint":"%s"}' '${nodeId}' "$PUBLIC_IP" ${capacity} "$MEM_FIELD" "$CPU_FIELD" "$HOST_KEY_FINGERPRINT")
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
  - path: /usr/local/sbin/eliza-container-egress-guard.sh
    permissions: '0755'
    content: |
      #!/bin/sh
      set -eu
      iptables -N DOCKER-USER 2>/dev/null || true
      iptables -C DOCKER-USER -d ${CLOUD_METADATA_IP}/32 -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -d ${CLOUD_METADATA_IP}/32 -j DROP
  - path: /etc/systemd/system/eliza-container-egress-guard.service
    permissions: '0644'
    content: |
      [Unit]
      Description=Block Docker container access to cloud metadata endpoint
      Requires=docker.service
      After=docker.service

      [Service]
      Type=oneshot
      ExecStart=/usr/local/sbin/eliza-container-egress-guard.sh
      RemainAfterExit=yes

      [Install]
      WantedBy=multi-user.target

runcmd:
  - chage -M 99999 -E -1 root || true
  - mkdir -p /data/containers /data/agents
  - chmod 0700 /data/containers /data/agents
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - systemctl daemon-reload
  - systemctl enable --now eliza-container-egress-guard.service
  - docker network inspect '${sanitizeShellSingleQuoted(network)}' >/dev/null 2>&1 || docker network create --driver bridge '${sanitizeShellSingleQuoted(network)}'
${registryAccessCommands}
  - ${buildEnsureEmbeddingSidecarCmd()} || echo '[bootstrap] embedding sidecar install failed; the node health loop will surface and self-heal it'
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
