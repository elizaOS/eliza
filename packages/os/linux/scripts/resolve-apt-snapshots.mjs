#!/usr/bin/env node
/**
 * Resolves the APT snapshot set for elizaOS Live builds.
 * Debian main and archives configured as `latest` follow authoritative Tails
 * trace metadata. Compatibility-sensitive frozen archives retain their
 * checked-in serial. Every required Release file is verified before the
 * expensive Docker and live-build stages begin.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://time-based.snapshots.deb.tails.boum.org";
const DEFAULT_CONFIG_DIR = fileURLToPath(
  new URL("../tails/config/APT_snapshots.d", import.meta.url),
);
const SERIAL_PATTERN = /^\d{10}$/;
const ORIGIN_CONTRACTS = [
  {
    name: "debian",
    followTrace: true,
    releasePaths: ["dists/trixie/Release", "dists/trixie-backports/Release"],
  },
  {
    name: "debian-security",
    followTrace: false,
    releasePaths: ["dists/trixie-security/Release"],
  },
  {
    name: "torproject",
    followTrace: false,
    releasePaths: ["dists/trixie/Release"],
  },
];

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Snapshot base URL must use HTTP(S), got ${url.protocol}`);
  }
  return url.href.replace(/\/$/, "");
}

async function request(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
      ...init,
    });
  } catch (cause) {
    // error-policy:J2 The endpoint identifies the failed upstream boundary.
    throw new Error(`Unable to reach Tails APT snapshot endpoint ${url}`, {
      cause,
    });
  }
}

async function latestSerial(fetchImpl, baseUrl, origin) {
  const traceUrl = `${baseUrl}/${origin}/project/trace/${origin}`;
  const response = await request(fetchImpl, traceUrl);
  if (!response.ok) {
    throw new Error(
      `Tails APT snapshot trace returned HTTP ${response.status}: ${traceUrl}`,
    );
  }

  const trace = await response.text();
  const serial = trace.match(/^Archive serial:\s*(\S+)\s*$/m)?.[1];
  if (!serial || !SERIAL_PATTERN.test(serial)) {
    throw new Error(`Invalid Archive serial in Tails trace: ${traceUrl}`);
  }
  return serial;
}

async function configuredSerial(configDir, origin) {
  const serialPath = path.join(configDir, origin, "serial");
  const serial = (await readFile(serialPath, "utf8")).trim();
  if (serial !== "latest" && !SERIAL_PATTERN.test(serial)) {
    throw new Error(`Invalid configured APT snapshot serial in ${serialPath}`);
  }
  return serial;
}

async function assertReleaseAvailable(
  fetchImpl,
  baseUrl,
  origin,
  serial,
  releasePath,
) {
  const releaseUrl = `${baseUrl}/${origin}/${serial}/${releasePath}`;
  const response = await request(fetchImpl, releaseUrl, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(
      `Tails APT snapshot is unavailable (HTTP ${response.status}): ${releaseUrl}`,
    );
  }
}

export async function resolveAptSnapshots({
  baseUrl = DEFAULT_BASE_URL,
  configDir = DEFAULT_CONFIG_DIR,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required");
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const snapshots = {};

  for (const contract of ORIGIN_CONTRACTS) {
    const configured = await configuredSerial(configDir, contract.name);
    const serial =
      contract.followTrace || configured === "latest"
        ? await latestSerial(fetchImpl, normalizedBaseUrl, contract.name)
        : configured;

    for (const releasePath of contract.releasePaths) {
      await assertReleaseAvailable(
        fetchImpl,
        normalizedBaseUrl,
        contract.name,
        serial,
        releasePath,
      );
    }
    snapshots[contract.name] = serial;
  }

  return snapshots;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const snapshots = await resolveAptSnapshots({
    baseUrl: process.env.TAILS_APT_SNAPSHOT_BASE_URL || DEFAULT_BASE_URL,
  });
  process.stdout.write(`${JSON.stringify(snapshots)}\n`);
}
