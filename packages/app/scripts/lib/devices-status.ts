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
  lease = null,
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
    lease,
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
    "LEASE",
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
    row.lease ? `pid ${row.lease.pid}` : "-",
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

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderDeviceStatusEvidenceSvg({
  table,
  generatedAt,
  title = "devices:status",
}) {
  const lines = String(table).split("\n");
  const fontSize = 18;
  const lineHeight = 28;
  const padding = 32;
  const longestLine = Math.max(...lines.map((line) => line.length), 1);
  const width = Math.max(960, padding * 2 + longestLine * 11);
  const height = padding * 2 + 44 + lines.length * lineHeight;
  const escapedTitle = escapeXml(title);
  const escapedGeneratedAt = escapeXml(generatedAt);
  const text = lines
    .map(
      (line, index) =>
        `<text x="${padding}" y="${padding + 72 + index * lineHeight}">${escapeXml(line)}</text>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#111111"/>
  <text x="${padding}" y="${padding + 12}" fill="#ffffff" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="22" font-weight="700">${escapedTitle}</text>
  <text x="${padding}" y="${padding + 42}" fill="#a3a3a3" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">${escapedGeneratedAt}</text>
  <g fill="#f5f5f5" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${fontSize}" xml:space="preserve">
${text}
  </g>
</svg>`;
}
