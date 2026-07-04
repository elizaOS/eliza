/**
 * Docker port-publish helpers for the Containers product's Hetzner node lane.
 *
 * Unlike Apps, this lane is reached by an off-node proxy through
 * `node.hostname:hostPort`; there is no node-local Caddy process that can dial
 * host loopback. The Docker publish flag therefore intentionally keeps Docker's
 * default all-interface bind so the documented off-node ingress can connect.
 */

/** Publish a container port on the Docker host's externally reachable interfaces. */
export function buildContainerPortPublishFlag(
  hostPort: number,
  containerPort: number | string,
): string {
  return `-p ${hostPort}:${containerPort}`;
}
