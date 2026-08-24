/**
 * Enforces loopback-only fetches inside the scenario subprocess and records an
 * append-only ledger. Real model calls must traverse the controller's loopback
 * proxy; direct provider or service egress is rejected before bytes are sent.
 */

import { appendFileSync } from "node:fs";

const ledgerPath = process.env.ELIZA_STABILITY_CHILD_NETWORK_LEDGER;
if (!ledgerPath) throw new Error("network guard requires its ledger path");
const nativeFetch = globalThis.fetch;
const loopback = (hostname) =>
  hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");

globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  const allowed = loopback(url.hostname);
  appendFileSync(
    ledgerPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      origin: url.origin,
      method: init?.method ?? "GET",
      allowed,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  if (!allowed)
    throw new Error(`stability network policy blocked ${url.origin}`);
  return nativeFetch(input, init);
};
