#!/usr/bin/env node
/**
 * Regenerate eliza/packages/docs/rest/lifeops.md from the actual route declarations
 * in eliza/plugins/app-lifeops/src/routes/.
 *
 * Source of truth:
 *  - plugin.ts: all 7 RouteSpec[] arrays (LIFEOPS_STATIC_ROUTES, LIFEOPS_DYNAMIC_ROUTES,
 *    LIFEOPS_SLEEP_ROUTES, WEBSITE_BLOCKER_ROUTES, CLOUD_FEATURE_ROUTES,
 *    TRAVEL_PROVIDER_RELAY_ROUTES, GOOGLE_CONNECTOR_ACCOUNT_ROUTES).
 *  - scheduled-tasks.ts: SCHEDULED_TASKS_ROUTE_PATHS export.
 *
 * Output: replaces the body of rest/lifeops.md while preserving the
 * Mintlify frontmatter and the hand-written intro paragraph.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PLUGIN_TS = resolve(
  REPO_ROOT,
  "plugins/app-lifeops/src/routes/plugin.ts",
);
const SCHEDULED_TASKS_TS = resolve(
  REPO_ROOT,
  "plugins/app-lifeops/src/routes/scheduled-tasks.ts",
);
const OUTPUT = resolve(REPO_ROOT, "packages/docs/rest/lifeops.md");

const ROUTE_REGEX =
  /\{\s*type:\s*"(GET|POST|PUT|PATCH|DELETE)"(?:\s+as\s+const)?\s*,\s*path:\s*"([^"]+)"/g;

function extractRoutes(filePath) {
  const text = readFileSync(filePath, "utf8");
  const out = [];
  for (const match of text.matchAll(ROUTE_REGEX)) {
    out.push({ method: match[1], path: match[2] });
  }
  return out;
}

function categorize(path) {
  // Strip /api/ prefix for grouping.
  const stripped = path.replace(/^\/api\//, "");
  const top = stripped.split("/")[0];
  const second = stripped.split("/")[1] ?? "";
  if (top === "lifeops") {
    if (
      ["entities", "relationships"].includes(second) ||
      ["entities", "relationships"].some((x) =>
        stripped.startsWith(`lifeops/${x}/`),
      )
    ) {
      return "Knowledge graph (entities + relationships)";
    }
    if (second === "scheduled-tasks" || stripped.startsWith("lifeops/dev/")) {
      return "Scheduled tasks (W1-A spine)";
    }
    if (
      second === "definitions" ||
      second === "occurrences" ||
      second === "goals"
    ) {
      return "Definitions, occurrences, goals";
    }
    if (second === "reminders" || second === "reminder-preferences") {
      return "Reminders";
    }
    if (second === "workflows") {
      return "Workflows";
    }
    if (second === "calendar") {
      return "Calendar";
    }
    if (second === "gmail") {
      return "Gmail";
    }
    if (second === "x") {
      return "X (Twitter)";
    }
    if (second === "money") {
      return "Money";
    }
    if (second === "screen-time" || second === "social") {
      return "Screen-time + social";
    }
    if (second === "schedule") {
      return "Schedule observations + merged state";
    }
    if (second === "sleep") {
      return "Sleep";
    }
    if (second === "health") {
      return "Health";
    }
    if (second === "connectors") {
      const provider = stripped.split("/")[2] ?? "unknown";
      const cap = provider.charAt(0).toUpperCase() + provider.slice(1);
      return `Connectors — ${cap}`;
    }
    if (second === "channels" || second === "channel-policies") {
      return "Channel policies";
    }
    if (second === "activity-signals" || second === "manual-override") {
      return "Activity signals + manual override";
    }
    if (second === "inbox") {
      return "Inbox";
    }
    if (
      second === "smart-features" ||
      second === "features" ||
      second === "capabilities"
    ) {
      return "Capabilities + feature flags";
    }
    if (second === "website-access") {
      return "Website blockers";
    }
    if (second === "permissions") {
      return "OS permissions";
    }
    if (second === "overview" || second === "app-state") {
      return "Overview + app-state";
    }
    return "Other LifeOps";
  }
  if (top === "website-blocker") {
    return "Website blockers";
  }
  if (top === "cloud") {
    return "Cloud bridge";
  }
  if (top === "connectors") {
    return "Connectors — Google account management";
  }
  return "Other";
}

function methodSortKey(method) {
  const order = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4 };
  return order[method] ?? 99;
}

function buildMarkdown(routes) {
  const groups = new Map();
  for (const route of routes) {
    const key = categorize(route.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(route);
  }
  // Sort within group by path then method.
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return methodSortKey(a.method) - methodSortKey(b.method);
    });
  }
  // Group order: keep "Overview + app-state" first, then alphabetical, with
  // "Other" sinks at the end.
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "Overview + app-state") return -1;
    if (b === "Overview + app-state") return 1;
    if (a.startsWith("Other") && !b.startsWith("Other")) return 1;
    if (b.startsWith("Other") && !a.startsWith("Other")) return -1;
    return a.localeCompare(b);
  });

  let body = "";
  body += "## Endpoint Index\n\n";
  body += `> This index is auto-generated from the route declarations in \`eliza/plugins/app-lifeops/src/routes/plugin.ts\` and \`scheduled-tasks.ts\` by \`eliza/scripts/generate-lifeops-rest-docs.mjs\`. Do not hand-edit; rerun the generator instead.\n\n`;
  body += `Total documented routes: **${routes.length}**.\n\n`;
  for (const key of sortedKeys) {
    const arr = groups.get(key);
    body += `### ${key}\n\n`;
    body += `| Method | Path |\n`;
    body += `|--------|------|\n`;
    for (const r of arr) {
      body += `| ${r.method} | \`${r.path}\` |\n`;
    }
    body += "\n";
  }

  body += "---\n\n";
  body += "## Notes\n\n";
  body += `- All endpoints under \`/api/lifeops\` require an active agent runtime; if the runtime is unavailable, the endpoint returns \`503 Service Unavailable\`.\n`;
  body += `- Public OAuth + connector callback routes (e.g. \`GET /api/lifeops/connectors/health/:provider/callback\`) are unauthenticated by design.\n`;
  body += `- Scheduled-task verbs (\`/api/lifeops/scheduled-tasks/:id/{snooze,skip,complete,dismiss,escalate,acknowledge,reopen,edit}\`) post no body when the verb is unambiguous; some accept JSON for context.\n`;
  body += `- Cadence kinds supported by definitions: \`once\`, \`daily\`, \`times_per_day\`, \`interval\`, \`weekly\`. Reminder channels: \`in_app\`, \`sms\`, \`voice\`, \`telegram\`, \`discord\`, \`signal\`, \`whatsapp\`, \`imessage\`, \`email\`, \`push\`.\n`;
  body += `- For request/response shape details, see \`eliza/plugins/app-lifeops/src/routes/lifeops-routes.ts\` and the corresponding handler in \`src/routes/{entities,relationships,scheduled-tasks,sleep-routes,website-blocker-routes}.ts\`. Each handler validates input via Zod schemas declared at module top.\n`;
  return body;
}

function regenerate() {
  const pluginRoutes = extractRoutes(PLUGIN_TS);
  const scheduledRoutes = extractRoutes(SCHEDULED_TASKS_TS);
  const routes = [...pluginRoutes, ...scheduledRoutes];

  // De-duplicate same {method,path} pairs (e.g., declared twice).
  const seen = new Set();
  const uniq = [];
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }

  const intro = `---
title: "LifeOps API"
sidebarTitle: "LifeOps"
description: "REST API endpoints for managing life-ops definitions, goals, occurrences, reminders, scheduled tasks, connectors, and the supporting knowledge graph."
---

The LifeOps API manages the agent's behavior-support and executive-assistant surface.
Definitions describe recurring tasks, habits, or routines; the engine generates occurrences
based on each definition's cadence. Goals group related definitions and track progress.
The same surface exposes scheduled tasks (the W1-A spine), connector pairing for the
messaging providers (Telegram, Signal, Discord, WhatsApp, iMessage, X), the entity and
relationship knowledge graph, sleep + health summaries, screen-time aggregates, money
ingestion, calendar/gmail integrations, and the workflow event triggers.

<Info>
LifeOps routes require an active agent runtime. If the runtime is unavailable, every endpoint
under \`/api/lifeops\` returns \`503 Service Unavailable\`.
</Info>

`;
  const body = buildMarkdown(uniq);
  writeFileSync(OUTPUT, intro + body);
  console.log(`Wrote ${OUTPUT} with ${uniq.length} routes.`);
}

regenerate();
