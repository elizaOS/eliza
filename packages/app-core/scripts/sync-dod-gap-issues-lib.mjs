export const MANAGED_LABEL = "integration-dod-gap";
export const MARKER_PREFIX = "integration-dod-gap-id:";
export const DRAFTS_SECTION_HEADER = "## 9) GitHub Issue Drafts";

export function stripOuterBackticks(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^`([\s\S]+)`$/);
  return match ? match[1].trim() : trimmed;
}

export function parseInlineList(value) {
  const values = [];
  const codeMatches = [...value.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  if (codeMatches.length > 0) return codeMatches;
  for (const item of value.split(",")) {
    const v = item.trim();
    if (v) values.push(v);
  }
  return values;
}

export function extractIssueDraftSection(markdown, reportPath) {
  const start = markdown.indexOf(DRAFTS_SECTION_HEADER);
  if (start < 0) {
    throw new Error(
      `Could not find "${DRAFTS_SECTION_HEADER}" in ${reportPath}`,
    );
  }
  const rest = markdown.slice(start);
  const nextSectionOffset = rest
    .slice(DRAFTS_SECTION_HEADER.length)
    .search(/\n##\s+\d+\)/);
  if (nextSectionOffset < 0) return rest;
  const end = start + DRAFTS_SECTION_HEADER.length + nextSectionOffset;
  return markdown.slice(start, end);
}

export function parseIssueDrafts(markdown, reportPath) {
  const section = extractIssueDraftSection(markdown, reportPath);
  const blocks = [
    ...section.matchAll(
      /###\s+(MW-\d+)\n([\s\S]*?)(?=\n###\s+MW-\d+|\n##\s+\d+\)|$)/g,
    ),
  ];
  if (blocks.length === 0) {
    throw new Error(
      "No MW-* issue draft blocks found in GitHub Issue Drafts section.",
    );
  }

  const drafts = [];
  for (const [, id, body] of blocks) {
    const draft = {
      id,
      title: "",
      labels: [],
      owner: "",
      acceptanceCriteria: [],
      verificationCommands: [],
      risks: [],
      sourceRefs: [],
    };

    let activeList = "";
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trimEnd();

      if (line.startsWith("- Title:")) {
        draft.title = stripOuterBackticks(line.slice("- Title:".length));
        activeList = "";
        continue;
      }
      if (line.startsWith("- Labels:")) {
        draft.labels = parseInlineList(line.slice("- Labels:".length));
        activeList = "";
        continue;
      }
      if (line.startsWith("- Owner:")) {
        draft.owner = stripOuterBackticks(line.slice("- Owner:".length));
        activeList = "";
        continue;
      }
      if (line.startsWith("- Acceptance criteria:")) {
        activeList = "acceptance";
        continue;
      }
      if (line.startsWith("- Verification commands:")) {
        activeList = "commands";
        continue;
      }
      if (line.startsWith("- Risk:")) {
        activeList = "risk";
        continue;
      }
      if (line.startsWith("- Source:")) {
        activeList = "source";
        continue;
      }
      if (line.startsWith("- ") || line.startsWith("### ")) {
        activeList = "";
        continue;
      }
      if (!line.startsWith("  - ")) {
        continue;
      }

      const item = stripOuterBackticks(line.slice(4).trim());
      if (!item) continue;
      if (activeList === "acceptance") draft.acceptanceCriteria.push(item);
      if (activeList === "commands") draft.verificationCommands.push(item);
      if (activeList === "risk") draft.risks.push(item);
      if (activeList === "source") draft.sourceRefs.push(item);
    }

    if (!draft.title) throw new Error(`Missing title for ${id}`);
    drafts.push(draft);
  }
  return drafts;
}

export function buildIssueBody(draft) {
  const lines = [];
  lines.push(`<!-- ${MARKER_PREFIX}${draft.id} -->`);
  lines.push(
    "This issue is auto-generated from `INTEGRATION_DOD_MAP.md` by the nightly DoD gap sync workflow.",
  );
  lines.push("");
  lines.push("## Gap");
  lines.push(`- **ID:** ${draft.id}`);
  lines.push(`- **Owner (area-owner):** ${draft.owner || "UNKNOWN"}`);
  lines.push("");
  lines.push("## Acceptance Criteria");
  if (draft.acceptanceCriteria.length === 0) {
    lines.push("- (No acceptance criteria provided in report)");
  } else {
    for (const criterion of draft.acceptanceCriteria) {
      lines.push(`- ${criterion}`);
    }
  }
  lines.push("");
  lines.push("## Verification Commands");
  if (draft.verificationCommands.length === 0) {
    lines.push("- (No verification commands provided in report)");
  } else {
    lines.push("```bash");
    for (const cmd of draft.verificationCommands) {
      lines.push(cmd);
    }
    lines.push("```");
  }
  lines.push("");
  lines.push("## Risk");
  if (draft.risks.length === 0) {
    lines.push("- (No risk details provided in report)");
  } else {
    for (const risk of draft.risks) {
      lines.push(`- ${risk}`);
    }
  }
  lines.push("");
  lines.push("## Source");
  if (draft.sourceRefs.length === 0) {
    lines.push("- `INTEGRATION_DOD_MAP.md`");
  } else {
    for (const source of draft.sourceRefs) {
      lines.push(`- \`${source}\``);
    }
  }
  return lines.join("\n");
}

export function desiredTitle(draft) {
  return `[Integration DoD][${draft.id}] ${draft.title}`;
}

export function labelColor(name) {
  if (name === MANAGED_LABEL) return "B60205";
  if (name.startsWith("priority:P0")) return "B60205";
  if (name.startsWith("priority:P1")) return "D93F0B";
  if (name.startsWith("priority:P2")) return "FBCA04";
  if (name.startsWith("area:")) return "0E8A16";
  if (name.startsWith("owner:")) return "1D76DB";
  if (name.startsWith("gap:")) return "5319E7";
  return "C5DEF5";
}

export function labelsForDraft(draft, existingLabelSet) {
  const set = new Set([
    MANAGED_LABEL,
    `gap:${draft.id}`,
    ...(draft.labels ?? []),
    draft.owner ? `owner:${draft.owner}` : "",
  ]);
  set.delete("");

  const labels = [...set];
  if (!(existingLabelSet instanceof Set)) return labels;
  return labels.filter((name) => existingLabelSet.has(name));
}

export function normalizeLabels(issueLabels) {
  return [
    ...new Set((issueLabels ?? []).map((label) => label.name).filter(Boolean)),
  ]
    .slice()
    .sort((a, b) => a.localeCompare(b));
}

export function extractManagedGapId(issueBody) {
  const match = String(issueBody ?? "").match(
    new RegExp(`${MARKER_PREFIX}(MW-\\d+)`),
  );
  return match ? match[1] : "";
}
