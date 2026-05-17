#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  buildIssueBody,
  desiredTitle,
  extractManagedGapId,
  labelColor,
  labelsForDraft,
  MANAGED_LABEL,
  normalizeLabels,
  parseIssueDrafts,
} from "./sync-dod-gap-issues-lib.mjs";

const REPORT_PATH =
  process.env.INTEGRATION_DOD_REPORT ?? "INTEGRATION_DOD_MAP.md";
const API_BASE = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REPO_SLUG = process.env.GITHUB_REPOSITORY ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "false");
const CLOSE_RESOLVED_GAPS = !/^(0|false|no)$/i.test(
  process.env.CLOSE_RESOLVED_GAPS ?? "true",
);

function fail(message) {
  console.error(`[sync-dod-gap-issues] ${message}`);
  process.exit(1);
}

if (!REPO_SLUG?.includes("/")) {
  fail("GITHUB_REPOSITORY must be set (owner/repo).");
}
if (!DRY_RUN && !TOKEN) {
  fail("GITHUB_TOKEN or GH_TOKEN is required unless DRY_RUN=1.");
}

const [owner, repo] = REPO_SLUG.split("/", 2);

async function ghRequest(method, path, body) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const details = data?.message ?? text ?? `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: ${res.status} ${details}`);
  }
  return data;
}

async function listAll(path) {
  const out = [];
  let page = 1;
  while (true) {
    const pagePath = `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
    const data = await ghRequest("GET", pagePath);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    if (data.length < 100) break;
    page += 1;
  }
  return out;
}

async function ensureLabels(labels) {
  const existing = await listAll(`/repos/${owner}/${repo}/labels`);
  const existingSet = new Set(existing.map((label) => label.name));

  for (const label of labels) {
    if (existingSet.has(label)) continue;
    if (DRY_RUN) {
      console.log(`[dry-run] would create label: ${label}`);
      existingSet.add(label);
      continue;
    }
    try {
      await ghRequest("POST", `/repos/${owner}/${repo}/labels`, {
        name: label,
        color: labelColor(label),
        description: "Managed by Integration DoD gap sync workflow",
      });
      existingSet.add(label);
      console.log(`created label: ${label}`);
    } catch (error) {
      console.warn(
        `warning: failed to create label "${label}": ${error.message}`,
      );
    }
  }
  return existingSet;
}

async function main() {
  const markdown = readFileSync(REPORT_PATH, "utf8");
  const drafts = parseIssueDrafts(markdown, REPORT_PATH);
  console.log(`parsed ${drafts.length} gap drafts from ${REPORT_PATH}`);

  const requiredLabels = drafts.flatMap((draft) => labelsForDraft(draft));
  const labelSet = await ensureLabels([...new Set(requiredLabels)]);

  const openManagedIssues = (
    await listAll(
      `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(MANAGED_LABEL)}`,
    )
  ).filter((issue) => !issue.pull_request);

  const existingById = new Map();
  for (const issue of openManagedIssues) {
    const gapId = extractManagedGapId(issue.body);
    if (!gapId) continue;
    existingById.set(gapId, issue);
  }

  const activeIds = new Set();
  for (const draft of drafts) {
    activeIds.add(draft.id);

    const labels = labelsForDraft(draft, labelSet);
    const title = desiredTitle(draft);
    const body = buildIssueBody(draft);
    const existing = existingById.get(draft.id);

    if (!existing) {
      if (DRY_RUN) {
        console.log(`[dry-run] create issue ${draft.id}: ${title}`);
      } else {
        const created = await ghRequest(
          "POST",
          `/repos/${owner}/${repo}/issues`,
          {
            title,
            body,
            labels,
          },
        );
        console.log(`created issue #${created.number} for ${draft.id}`);
      }
      continue;
    }

    const existingLabels = normalizeLabels(existing.labels);
    const desiredLabels = [...labels].sort((a, b) => a.localeCompare(b));
    const labelsChanged =
      JSON.stringify(existingLabels) !== JSON.stringify(desiredLabels);
    const titleChanged = existing.title !== title;
    const bodyChanged = String(existing.body ?? "") !== body;

    if (!labelsChanged && !titleChanged && !bodyChanged) {
      console.log(`no changes for ${draft.id} (#${existing.number})`);
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `[dry-run] update ${draft.id} (#${existing.number})` +
          ` titleChanged=${titleChanged} bodyChanged=${bodyChanged} labelsChanged=${labelsChanged}`,
      );
    } else {
      await ghRequest(
        "PATCH",
        `/repos/${owner}/${repo}/issues/${existing.number}`,
        {
          title,
          body,
          labels: desiredLabels,
        },
      );
      console.log(`updated issue #${existing.number} for ${draft.id}`);
    }
  }

  if (!CLOSE_RESOLVED_GAPS) {
    console.log(
      "CLOSE_RESOLVED_GAPS=false, skipping close-out for removed gaps.",
    );
    return;
  }

  for (const issue of openManagedIssues) {
    const gapId = extractManagedGapId(issue.body);
    if (!gapId || activeIds.has(gapId)) continue;

    if (DRY_RUN) {
      console.log(
        `[dry-run] close resolved issue #${issue.number} (missing from report): ${gapId}`,
      );
      continue;
    }

    await ghRequest(
      "POST",
      `/repos/${owner}/${repo}/issues/${issue.number}/comments`,
      {
        body: "Closing automatically: this gap is no longer present in `INTEGRATION_DOD_MAP.md`.",
      },
    );
    await ghRequest("PATCH", `/repos/${owner}/${repo}/issues/${issue.number}`, {
      state: "closed",
    });
    console.log(`closed resolved issue #${issue.number} (${gapId})`);
  }
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
