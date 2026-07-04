/**
 * Renders a PathologyReport into the Markdown the GIT_PATHOLOGY action returns:
 * a header block, the peak and drift inflection lists, and the rot post-mortem.
 */

import type { InflectionPoint, PathologyReport, RotCause } from "./types.ts";

function short(sha: string): string {
  return sha.slice(0, 7);
}

function inflectionLine(point: InflectionPoint): string {
  const direction = point.delta >= 0 ? "+" : "";
  return `- \`${short(point.sha)}\` (${point.date.slice(0, 10)}, ${point.author}): score ${point.score.toFixed(2)} ${direction}${point.delta.toFixed(2)} — ${point.reasonShort}`;
}

function rotCauseBlock(cause: RotCause): string {
  const [from, to] = cause.shaRange;
  const evidence =
    cause.evidence.length > 0 ? `\n  - Evidence: ${cause.evidence.map(short).join(", ")}` : "";
  return `### ${cause.category} — \`${short(from)}\`..\`${short(to)}\`\n\n${cause.narrative}${evidence}`;
}

export function renderReport(report: PathologyReport): string {
  const window = `${report.window.since.slice(0, 10)} → ${report.window.until.slice(0, 10)}`;
  const peaks =
    report.peaks.length === 0
      ? "_None detected in window._"
      : report.peaks.map(inflectionLine).join("\n");
  const drifts =
    report.drifts.length === 0
      ? "_None detected in window._"
      : report.drifts.map(inflectionLine).join("\n");
  const causes =
    report.rotCauses.length === 0
      ? "_No drift narration generated. Either no drifts detected, or budget = 0._"
      : report.rotCauses.map(rotCauseBlock).join("\n\n");
  const authors = report.authors.length > 0 ? report.authors.join(", ") : "_none_";

  return `# Git Pathology — \`${report.surface}\`

**Repo:** \`${report.repoRoot}\`
**Window:** ${window}
**HEAD:** \`${short(report.headSha)}\`
**Commits analyzed:** ${report.commitCount} (${authors})
**LLM calls:** ${report.llmCalls}

## Peaks (local maxima of health)

${peaks}

## Drift inflections (sustained downturns)

${drifts}

## Rot post-mortem

${causes}
`;
}
