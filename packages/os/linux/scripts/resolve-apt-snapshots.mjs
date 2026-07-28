#!/usr/bin/env node
/**
 * Resolves the APT snapshot set for elizaOS Live builds.
 * Debian main and archives configured as `latest` follow authoritative Tails
 * trace metadata. Compatibility-sensitive frozen archives retain their
 * checked-in serial. The versioned Tails package suite is checked for every
 * patched package required by the vendored build before expensive image work.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://time-based.snapshots.deb.tails.boum.org";
const DEFAULT_TAILS_REPOSITORY_URL = "https://deb.tails.boum.org";
const DEFAULT_CONFIG_DIR = fileURLToPath(
  new URL("../tails/config/APT_snapshots.d", import.meta.url),
);
const DEFAULT_TAILS_CHANGELOG = fileURLToPath(
  new URL("../tails/debian/changelog", import.meta.url),
);
const SERIAL_PATTERN = /^\d{10}$/;
const SUITE_PATTERN = /^[a-z0-9][a-z0-9._~-]*$/i;
const TAILS_VERSION_PATTERN = /tails[0-9]+$/;
const TAILS_BACKPORT_VERSION_PATTERN = /~tails[0-9]*$/;
const REQUIRED_TAILS_PACKAGES = [
  "apparmor",
  "apparmor-profiles",
  "evince",
  "evince-common",
  "flatpak",
  "haveged",
  "libapparmor1",
  "libevdocument3-4t64",
  "libevview3-3t64",
  "libgcrypt20",
  "libhavege2",
  "libyelp0",
  "yelp",
];
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
    throw new Error(`Unable to reach Tails APT endpoint ${url}`, {
      cause,
    });
  }
}

async function configuredTailsSuite(changelogPath) {
  const changelog = await readFile(changelogPath, "utf8");
  const version = changelog.match(/^tails \(([^)]+)\)/)?.[1];
  const suite = version?.replace(/[^.a-z0-9-]/gi, "-").toLowerCase();
  if (!suite || !SUITE_PATTERN.test(suite)) {
    throw new Error(
      `Unable to derive the Tails custom APT suite from ${changelogPath}`,
    );
  }
  return suite;
}

function packageVersions(index) {
  const versions = new Map();
  for (const stanza of index.split(/\n{2,}/)) {
    const packageName = stanza.match(/^Package:\s*(\S+)\s*$/m)?.[1];
    const version = stanza.match(/^Version:\s*(\S+)\s*$/m)?.[1];
    if (packageName && version) {
      versions.set(packageName, version);
    }
  }
  return versions;
}

async function assertTailsPackageClosure(fetchImpl, repositoryUrl, suite) {
  if (!SUITE_PATTERN.test(suite)) {
    throw new Error(`Invalid Tails custom APT suite: ${suite}`);
  }
  const packagesUrl = `${repositoryUrl}/dists/${suite}/main/binary-amd64/Packages`;
  const response = await request(fetchImpl, packagesUrl);
  if (!response.ok) {
    throw new Error(
      `Tails custom package index is unavailable (HTTP ${response.status}): ${packagesUrl}`,
    );
  }

  const versions = packageVersions(await response.text());
  const invalidPackages = REQUIRED_TAILS_PACKAGES.flatMap((packageName) => {
    const version = versions.get(packageName);
    return version &&
      TAILS_VERSION_PATTERN.test(version) &&
      !TAILS_BACKPORT_VERSION_PATTERN.test(version)
      ? []
      : [`${packageName} (${version ?? "missing"})`];
  });
  if (invalidPackages.length > 0) {
    throw new Error(
      `Tails custom package suite ${suite} lacks required patched packages: ${invalidPackages.join(", ")}`,
    );
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
  tailsChangelog = DEFAULT_TAILS_CHANGELOG,
  tailsRepositoryUrl = DEFAULT_TAILS_REPOSITORY_URL,
  tailsSuite,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required");
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedTailsRepositoryUrl = normalizeBaseUrl(tailsRepositoryUrl);
  const selectedTailsSuite =
    tailsSuite ??
    process.env.TAILS_CUSTOM_APT_SUITE ??
    (await configuredTailsSuite(tailsChangelog));
  await assertTailsPackageClosure(
    fetchImpl,
    normalizedTailsRepositoryUrl,
    selectedTailsSuite,
  );
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
    tailsRepositoryUrl:
      process.env.TAILS_CUSTOM_APT_BASE_URL || DEFAULT_TAILS_REPOSITORY_URL,
  });
  process.stdout.write(`${JSON.stringify(snapshots)}\n`);
}
