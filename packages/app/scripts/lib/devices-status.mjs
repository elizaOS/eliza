/**
 * Pure device-status policy shared by the CLI and tests. Device probing is
 * host-specific, but freshness verdicts must stay deterministic so stale
 * installs fail the same way on every machine.
 */

export function sameCommit(a, b) {
  if (!a || !b) return false;
  const left = String(a);
  const right = String(b);
  return left.startsWith(right) || right.startsWith(left);
}

export function shortSha(value) {
  return value ? String(value).slice(0, 12) : "-";
}

export function rendererStampVerdict({ stamp, developHead }) {
  if (!stamp) {
    return { verdict: "UNKNOWN", reason: "no installed renderer stamp" };
  }
  if (!stamp.commit) {
    return { verdict: "UNKNOWN", reason: "installed stamp has no commit" };
  }
  if (!developHead) {
    return { verdict: "UNKNOWN", reason: "origin/develop head unavailable" };
  }
  if (sameCommit(stamp.commit, developHead)) {
    return { verdict: "FRESH", reason: "installed commit matches develop" };
  }
  return {
    verdict: "STALE",
    reason: `installed ${shortSha(stamp.commit)} != develop ${shortSha(developHead)}`,
  };
}

export function buildDeviceStatusRow({
  platform,
  id,
  name,
  kind,
  stamp,
  developHead,
  source,
}) {
  const status = rendererStampVerdict({ stamp, developHead });
  return {
    platform,
    id,
    name: name || id,
    kind,
    buildId: stamp?.buildId ?? null,
    commit: stamp?.commit ?? null,
    developHead: developHead ?? null,
    verdict: status.verdict,
    reason: status.reason,
    source,
  };
}

export function hasNonFreshDevice(rows) {
  return rows.some((row) => row.kind !== "n/a" && row.verdict !== "FRESH");
}

export function formatDeviceStatusTable(rows) {
  const headers = [
    "PLATFORM",
    "DEVICE",
    "KIND",
    "BUILD",
    "COMMIT",
    "DEVELOP",
    "VERDICT",
    "REASON",
  ];
  const body = rows.map((row) => [
    row.platform,
    row.name || row.id,
    row.kind,
    shortSha(row.buildId),
    shortSha(row.commit),
    shortSha(row.developHead),
    row.verdict,
    row.reason,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => String(row[index]).length)),
  );
  const render = (row) =>
    row
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [
    render(headers),
    render(headers.map((h) => "-".repeat(h.length))),
    ...body.map(render),
  ].join("\n");
}
