/**
 * ssh2 — Cloudflare Workers compatibility shim.
 *
 * The real ssh2 package is Node-only (loads a `.node` native binding).
 * Docker node SSH operations live on the Node sidecar
 * (packages/cloud/shared/src/lib/services/docker-ssh.ts). The Worker is
 * bundled with this shim so transitive imports don't crash the build; any
 * code path that actually instantiates a Client at runtime throws a clear
 * error so the accidental Worker-side call is visible immediately.
 */

const NOT_AVAILABLE =
  "ssh2 is not available on Cloudflare Workers — Docker node SSH operations run on the Node sidecar (packages/cloud/shared/src/lib/services/docker-ssh.ts).";

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

const workerSsh2Surface = { Client, Server, utils };
export default workerSsh2Surface;
