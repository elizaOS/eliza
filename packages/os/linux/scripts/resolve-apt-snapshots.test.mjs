/**
 * Verifies snapshot resolution against deterministic HTTP responses so builds
 * reject pruned mirrors before attempting live-image assembly.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveAptSnapshots } from "./resolve-apt-snapshots.mjs";

const temporaryDirectories = [];
const execFileAsync = promisify(execFile);
const prepareSnapshotsScript = fileURLToPath(
  new URL("../tails/auto/scripts/apt-snapshots-serials", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function snapshotConfig(serials) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "elizaos-apt-snapshots-"),
  );
  temporaryDirectories.push(directory);
  for (const [origin, serial] of Object.entries(serials)) {
    const originDirectory = path.join(directory, origin);
    await mkdir(originDirectory, { recursive: true });
    await writeFile(path.join(originDirectory, "serial"), `${serial}\n`);
  }
  return directory;
}

async function snapshotWorkspace(serials) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "elizaos-apt-snapshot-workspace-"),
  );
  temporaryDirectories.push(directory);
  for (const [origin, serial] of Object.entries(serials)) {
    const originDirectory = path.join(
      directory,
      "config",
      "APT_snapshots.d",
      origin,
    );
    await mkdir(originDirectory, { recursive: true });
    await writeFile(path.join(originDirectory, "serial"), `${serial}\n`);
  }
  return directory;
}

function deterministicFetch(responses) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ method: init.method ?? "GET", url });
    return responses.get(url) ?? new Response("missing", { status: 404 });
  };
  return { fetchImpl, requests };
}

function availableResponses(baseUrl) {
  return new Map([
    [
      `${baseUrl}/debian/project/trace/debian`,
      new Response("Archive serial: 2026072704\n"),
    ],
    [
      `${baseUrl}/debian-security/project/trace/debian-security`,
      new Response("Archive serial: 2026072704\n"),
    ],
    [`${baseUrl}/debian/2026072704/dists/trixie/Release`, new Response(null)],
    [
      `${baseUrl}/debian/2026072704/dists/trixie-backports/Release`,
      new Response(null),
    ],
    [
      `${baseUrl}/debian-security/2026072704/dists/trixie-security/Release`,
      new Response(null),
    ],
    [
      `${baseUrl}/torproject/2026050704/dists/trixie/Release`,
      new Response(null),
    ],
  ]);
}

test("refreshes Debian, resolves latest security, and retains the Tor pin", async () => {
  const baseUrl = "https://snapshots.test";
  const configDir = await snapshotConfig({
    debian: "2026070701",
    "debian-security": "latest",
    torproject: "2026050704",
  });
  const { fetchImpl, requests } = deterministicFetch(
    availableResponses(baseUrl),
  );

  const snapshots = await resolveAptSnapshots({
    baseUrl,
    configDir,
    fetchImpl,
  });

  assert.deepEqual(snapshots, {
    debian: "2026072704",
    "debian-security": "2026072704",
    torproject: "2026050704",
  });
  assert.equal(
    requests.some(({ url }) =>
      url.includes("/torproject/project/trace/torproject"),
    ),
    false,
  );
  assert.equal(requests.filter(({ method }) => method === "HEAD").length, 4);
});

test("fails when a required Release file was pruned", async () => {
  const baseUrl = "https://snapshots.test";
  const configDir = await snapshotConfig({
    debian: "2026070701",
    "debian-security": "latest",
    torproject: "2026050704",
  });
  const responses = availableResponses(baseUrl);
  responses.set(
    `${baseUrl}/debian/2026072704/dists/trixie-backports/Release`,
    new Response(null, { status: 404 }),
  );
  const { fetchImpl } = deterministicFetch(responses);

  await assert.rejects(
    resolveAptSnapshots({ baseUrl, configDir, fetchImpl }),
    /snapshot is unavailable \(HTTP 404\).*trixie-backports\/Release/,
  );
});

test("rejects malformed authoritative trace metadata", async () => {
  const baseUrl = "https://snapshots.test";
  const configDir = await snapshotConfig({
    debian: "2026070701",
    "debian-security": "latest",
    torproject: "2026050704",
  });
  const responses = availableResponses(baseUrl);
  responses.set(
    `${baseUrl}/debian/project/trace/debian`,
    new Response("Archive serial: ../../latest\n"),
  );
  const { fetchImpl } = deterministicFetch(responses);

  await assert.rejects(
    resolveAptSnapshots({ baseUrl, configDir, fetchImpl }),
    /Invalid Archive serial/,
  );
});

test("verified serial maps override frozen and latest build inputs", async () => {
  const workspace = await snapshotWorkspace({
    debian: "2026070701",
    "debian-security": "latest",
    torproject: "2026050704",
  });
  const snapshots = {
    debian: "2026072801",
    "debian-security": "2026072801",
    torproject: "2026050704",
  };

  await execFileAsync(
    prepareSnapshotsScript,
    ["prepare-build", JSON.stringify(snapshots)],
    { cwd: workspace },
  );

  for (const [origin, expected] of Object.entries(snapshots)) {
    const serial = await readFile(
      path.join(workspace, "tmp", "APT_snapshots.d", origin, "serial"),
      "utf8",
    );
    assert.equal(serial.trim(), expected);
  }
});
