/**
 * ssh2 — Cloudflare Workers stub.
 *
 * The real ssh2 package is Node-only (loads a `.node` native binding).
 * Container/agent SSH operations live on the Node sidecar
 * (`services/agent-server` + Hetzner Docker pool — see cloud/INFRA.md
 * "Long-running services NOT migrated"). The Worker is bundled with this
 * stub so transitive imports don't crash the build; any code path that
 * actually instantiates a Client at runtime throws a clear error so the
 * accidental Worker-side call is visible immediately.
 */

const NOT_AVAILABLE =
  "ssh2 is not available on Cloudflare Workers — proxy to the Node sidecar (cloud/INFRA.md).";

export class Client {
  constructor() {
    throw new Error(NOT_AVAILABLE);
  }
}

export class Server {
  constructor() {
    throw new Error(NOT_AVAILABLE);
  }
}

export const utils = new Proxy(
  {},
  {
    get() {
      throw new Error(NOT_AVAILABLE);
    },
  },
);

const stub = { Client, Server, utils };
export default stub;
