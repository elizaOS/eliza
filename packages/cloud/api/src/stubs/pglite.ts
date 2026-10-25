/**
 * Worker-only replacement for the local PGlite runtime.
 *
 * Cloud deployments connect through Hyperdrive and reject `pglite://` URLs,
 * so bundling the embedded Postgres engine only consumes startup CPU and can
 * never serve a production request.
 */

function unavailable(): never {
  throw new Error(
    "PGlite is local-only and unavailable in the Cloudflare Worker runtime.",
  );
}

export class PGlite {
  constructor() {
    unavailable();
  }
}

export const vector = unavailable;
export const btree_gist = unavailable;

export const types = {
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  INTERVAL: 1186,
  DATE: 1082,
} as const;
