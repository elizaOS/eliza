#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  extractMethods,
  findCloudApiRoot,
  isGeneratedPublicRoute,
  routePathFromSegments,
  scopeForRoute,
  walkRoutes,
} from "./route-discovery.mjs";

const SDK_TYPED_ROUTES = new Map(
  [
    ["GET", "/api/openapi.json", "getOpenApiSpec"],
    ["POST", "/api/auth/cli-session", "startCliLogin"],
    ["GET", "/api/auth/cli-session/{sessionId}", "pollCliLogin"],
    ["POST", "/api/auth/pair", "pairWithToken"],
    ["GET", "/api/v1/models", "listModels"],
    ["POST", "/api/v1/responses", "createResponse"],
    ["POST", "/api/v1/chat/completions", "createChatCompletion"],
    ["POST", "/api/v1/embeddings", "createEmbeddings"],
    ["POST", "/api/v1/generate-image", "generateImage"],
    ["GET", "/api/v1/credits/balance", "getCreditsBalance"],
    ["GET", "/api/v1/credits/summary", "getCreditsSummary"],
    ["GET", "/api/v1/containers", "listContainers"],
    ["POST", "/api/v1/containers", "createContainer"],
    ["GET", "/api/v1/containers/{id}", "getContainer"],
    ["PATCH", "/api/v1/containers/{id}", "updateContainer"],
    ["DELETE", "/api/v1/containers/{id}", "deleteContainer"],
    ["GET", "/api/v1/containers/{id}/health", "getContainerHealth"],
    ["GET", "/api/v1/containers/{id}/metrics", "getContainerMetrics"],
    ["GET", "/api/v1/containers/{id}/logs", "getContainerLogs"],
    ["GET", "/api/v1/containers/{id}/deployments", "getContainerDeployments"],
    ["GET", "/api/v1/containers/quota", "getContainerQuota"],
    ["POST", "/api/v1/containers/credentials", "createContainerCredentials"],
    ["GET", "/api/v1/eliza/agents", "listAgents"],
    ["POST", "/api/v1/eliza/agents", "createAgent"],
    ["GET", "/api/v1/eliza/agents/{agentId}", "getAgent"],
    ["PATCH", "/api/v1/eliza/agents/{agentId}", "updateAgent"],
    ["DELETE", "/api/v1/eliza/agents/{agentId}", "deleteAgent"],
    ["POST", "/api/v1/eliza/agents/{agentId}/provision", "provisionAgent"],
    ["POST", "/api/v1/eliza/agents/{agentId}/suspend", "suspendAgent"],
    ["POST", "/api/v1/eliza/agents/{agentId}/resume", "resumeAgent"],
    ["POST", "/api/v1/eliza/agents/{agentId}/snapshot", "createAgentSnapshot"],
    ["GET", "/api/v1/eliza/agents/{agentId}/backups", "listAgentBackups"],
    ["POST", "/api/v1/eliza/agents/{agentId}/restore", "restoreAgentBackup"],
    ["POST", "/api/v1/eliza/agents/{agentId}/pairing-token", "getAgentPairingToken"],
    ["POST", "/api/v1/eliza/gateway-relay/sessions", "registerGatewayRelaySession"],
    ["GET", "/api/v1/eliza/gateway-relay/sessions/{sessionId}/next", "pollGatewayRelayRequest"],
    [
      "POST",
      "/api/v1/eliza/gateway-relay/sessions/{sessionId}/responses",
      "submitGatewayRelayResponse",
    ],
    ["DELETE", "/api/v1/eliza/gateway-relay/sessions/{sessionId}", "disconnectGatewayRelaySession"],
    ["GET", "/api/v1/jobs/{jobId}", "getJob"],
    ["GET", "/api/v1/user", "getUser"],
    ["PATCH", "/api/v1/user", "updateUser"],
    ["GET", "/api/v1/api-keys", "listApiKeys"],
    ["POST", "/api/v1/api-keys", "createApiKey"],
    ["PATCH", "/api/v1/api-keys/{id}", "updateApiKey"],
    ["DELETE", "/api/v1/api-keys/{id}", "deleteApiKey"],
    ["POST", "/api/v1/api-keys/{id}/regenerate", "regenerateApiKey"],
  ].map(([method, route, sdkMethod]) => [`${method} ${route}`, sdkMethod]),
);

async function readGeneratedRouteMethods(cloudRoot) {
  const sourcePath = path.join(cloudRoot, "packages", "sdk", "src", "public-routes.ts");
  const source = await readFile(sourcePath, "utf8");
  const endpointRe =
    /^\s+"([^"]+)": \{ method: "([^"]+)", path: "([^"]+)", methodName: "([^"]+)"/gm;
  const routes = new Map();

  for (const match of source.matchAll(endpointRe)) {
    routes.set(match[1], match[4]);
  }
  return routes;
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const parts = row.route.split("/").filter(Boolean);
    const key = row.route.startsWith("/api/v1/") ? parts[2] : (parts[1] ?? "root");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
}

function table(rows, columns) {
  const header = `| ${columns.map((column) => column.title).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => column.value(row)).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function routeTable(rows) {
  return table(rows, [
    { title: "Method", value: (row) => row.method },
    { title: "Route", value: (row) => `\`${row.route}\`` },
    { title: "Source", value: (row) => `\`${row.file}\`` },
  ]);
}

function coverageTable(rows) {
  return table(rows, [
    { title: "Method", value: (row) => row.method },
    { title: "Route", value: (row) => `\`${row.route}\`` },
    { title: "SDK Method", value: (row) => `\`${row.sdkMethod}\`` },
    { title: "Source", value: (row) => `\`${row.file}\`` },
  ]);
}

const { cloudRoot, apiRoot, relativeApiRoot } = await findCloudApiRoot(process.cwd());
const generatedRoutes = await readGeneratedRouteMethods(cloudRoot);
const routeFiles = await walkRoutes(apiRoot);
const routePairs = [];

for (const routeFile of routeFiles) {
  const source = await readFile(routeFile.fullPath, "utf8");
  const route = routePathFromSegments(routeFile.relativeSegments);
  const file = path.relative(cloudRoot, routeFile.fullPath);
  for (const method of await extractMethods(source, routeFile.fullPath, cloudRoot)) {
    if (method === "OPTIONS" || method === "HEAD") continue;
    routePairs.push({ method, route, file, scope: scopeForRoute(route) });
  }
}

routePairs.sort((a, b) => `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`));

const publicPairs = routePairs.filter((row) => isGeneratedPublicRoute(row.route));
const nonPublicPairs = routePairs.filter((row) => row.scope !== "public");
const coveredRoutePairs = routePairs
  .filter((row) => generatedRoutes.has(`${row.method} ${row.route}`))
  .map((row) => ({ ...row, sdkMethod: generatedRoutes.get(`${row.method} ${row.route}`) }));
const missingRoutePairs = publicPairs.filter(
  (row) => !generatedRoutes.has(`${row.method} ${row.route}`),
);
const generatedRoutesWithoutRouteFile = Array.from(generatedRoutes.entries())
  .filter(([key]) => !routePairs.some((row) => `${row.method} ${row.route}` === key))
  .map(([key, sdkMethod]) => ({ key, sdkMethod }));
const generatedNonPublicRoutes = Array.from(generatedRoutes.entries())
  .map(([key, sdkMethod]) => {
    const [method, ...routeParts] = key.split(" ");
    const route = routeParts.join(" ");
    return { key, method, route, sdkMethod, scope: scopeForRoute(route) };
  })
  .filter((row) => !isGeneratedPublicRoute(row.route));
const highLevelRoutesWithoutRouteFile = Array.from(SDK_TYPED_ROUTES.entries())
  .filter(([key]) => !routePairs.some((row) => `${row.method} ${row.route}` === key))
  .map(([key, sdkMethod]) => ({ key, sdkMethod }));

const routeScopeSummary = Array.from(
  routePairs.reduce((summary, row) => {
    summary.set(row.scope, (summary.get(row.scope) ?? 0) + 1);
    return summary;
  }, new Map()),
).sort(([a], [b]) => a.localeCompare(b));

const missingGroupSummary =
  groupRows(missingRoutePairs)
    .map(([group, rows]) => `| ${group} | ${rows.length} |`)
    .join("\n") || "| none | 0 |";

const lines = [
  "# Eliza Cloud SDK Route Coverage Audit",
  "",
  `Generated by \`bun run audit:routes\` from the real route tree under \`${relativeApiRoot}\`.`,
  "",
  "## Summary",
  "",
  `- Total route method pairs under \`${relativeApiRoot}\`: ${routePairs.length}`,
  `- Generated public route method pairs: ${publicPairs.length}`,
  `- Non-public route method pairs: ${nonPublicPairs.length}`,
  `- Route method pairs with generated SDK wrappers: ${coveredRoutePairs.length}`,
  `- Public route method pairs missing generated SDK wrappers: ${missingRoutePairs.length}`,
  `- Generated SDK route wrappers with no matching route file: ${generatedRoutesWithoutRouteFile.length}`,
  `- Generated SDK route wrappers outside public scope: ${generatedNonPublicRoutes.length}`,
  `- High-level SDK helper route declarations with no matching route file: ${highLevelRoutesWithoutRouteFile.length}`,
  "",
  "## Route Scope Counts",
  "",
  "| Scope | Route Method Pairs |",
  "| --- | --- |",
  ...routeScopeSummary.map(([scope, count]) => `| ${scope} | ${count} |`),
  "",
  "## Missing Public SDK Wrappers By Group",
  "",
  "| Group | Missing Route Method Pairs |",
  "| --- | --- |",
  missingGroupSummary,
  "",
  "## Covered Routes",
  "",
  coverageTable(coveredRoutePairs),
  "",
  "## Missing Public Routes",
  "",
];

for (const [group, rows] of groupRows(missingRoutePairs)) {
  lines.push(`### ${group}`, "", routeTable(rows), "");
}
if (missingRoutePairs.length === 0) {
  lines.push("None.", "");
}

lines.push("## Non-Public Route Inventory", "");
for (const [scope, rows] of groupRows(routePairs.filter((row) => row.scope !== "public"))) {
  lines.push(`### ${scope}`, "", routeTable(rows), "");
}

if (generatedRoutesWithoutRouteFile.length > 0) {
  lines.push("## Generated SDK Routes Without Matching Route File", "");
  lines.push(
    table(generatedRoutesWithoutRouteFile, [
      { title: "Route", value: (row) => `\`${row.key}\`` },
      { title: "SDK Method", value: (row) => `\`${row.sdkMethod}\`` },
    ]),
  );
  lines.push("");
}

if (generatedNonPublicRoutes.length > 0) {
  lines.push("## Generated SDK Routes Outside Public Scope", "");
  lines.push(
    table(generatedNonPublicRoutes, [
      { title: "Route", value: (row) => `\`${row.key}\`` },
      { title: "SDK Method", value: (row) => `\`${row.sdkMethod}\`` },
      { title: "Scope", value: (row) => row.scope },
    ]),
  );
  lines.push("");
}

if (highLevelRoutesWithoutRouteFile.length > 0) {
  lines.push("## High-Level SDK Helper Routes Without Matching Route File", "");
  lines.push(
    table(highLevelRoutesWithoutRouteFile, [
      { title: "Route", value: (row) => `\`${row.key}\`` },
      { title: "SDK Method", value: (row) => `\`${row.sdkMethod}\`` },
    ]),
  );
  lines.push("");
}

process.stdout.write(`${lines.join("\n")}\n`);

if (
  missingRoutePairs.length > 0 ||
  generatedRoutesWithoutRouteFile.length > 0 ||
  generatedNonPublicRoutes.length > 0
) {
  console.error(
    `Route coverage failed: ${missingRoutePairs.length} missing public, ${generatedRoutesWithoutRouteFile.length} orphan generated, ${generatedNonPublicRoutes.length} non-public generated routes.`,
  );
  process.exitCode = 1;
}
