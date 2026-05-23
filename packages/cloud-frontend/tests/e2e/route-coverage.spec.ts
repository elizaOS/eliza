import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "../..");
const SRC_ROOT = path.join(PACKAGE_ROOT, "src");
const APP_SOURCE = path.join(SRC_ROOT, "App.tsx");
const CLOUD_ROUTES_SPEC = path.join(HERE, "cloud-routes.spec.ts");
const LIVE_AUTH_DASHBOARD_SPEC = path.join(HERE, "live-auth-dashboard.spec.ts");
const LIVE_STEWARD_WALLET_LOGIN_SPEC = path.join(
  HERE,
  "live-steward-wallet-login.spec.ts",
);

const ROUTE_PARAM_EXAMPLES: Record<string, string> = {
  ":approvalId": "approval_1",
  ":appId": "app_1",
  ":ballotId": "ballot_1",
  ":characterRef": "agent_1",
  ":chargeId": "charge_1",
  ":id": "agent_1",
  ":paymentRequestId": "pay_req_1",
};

const ROUTE_SAMPLE_OVERRIDES: Record<string, string> = {
  "/dashboard/apps/:id": "/dashboard/apps/app_1",
  "/dashboard/invoices/:id": "/dashboard/invoices/inv_1",
};

function walkPageComponents(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...walkPageComponents(fullPath));
      continue;
    }
    if (entry === "page.tsx" || entry === "Page.tsx") {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function toAppImportPath(filePath: string): string {
  return `./${path
    .relative(SRC_ROOT, filePath)
    .replace(/\\/g, "/")
    .replace(/\.tsx$/, "")}`;
}

function lazyRouteImports(appSource: string): Set<string> {
  return new Set(
    [
      ...appSource.matchAll(
        /lazyWithPreload\(\s*\(\)\s*=>\s*import\("([^"]+)"\)/g,
      ),
    ]
      .map((match) => match[1])
      .filter((value): value is string => Boolean(value)),
  );
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function routePatternToSample(routePattern: string): string | null {
  if (routePattern.includes("*")) return null;
  const override = ROUTE_SAMPLE_OVERRIDES[routePattern];
  if (override) return override;
  const segments = routePattern.split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment;
    return ROUTE_PARAM_EXAMPLES[segment] ?? `${segment.slice(1)}_1`;
  });
  return normalizePath(segments.join("/"));
}

function routerRouteSamples(appSource: string): string[] {
  const routeStack: string[] = [];
  const samples = new Set<string>();

  for (const line of appSource.split("\n")) {
    const routeMatch = line.match(/<Route(?:\s+[^>]*)?>/);
    if (routeMatch) {
      const pathMatch = line.match(/path="([^"]+)"/);
      const indexRoute = /\sindex(?:\s|>|$)/.test(line);
      if (pathMatch || indexRoute) {
        const parentPath = routeStack.at(-1) ?? "";
        const ownPath = indexRoute ? "" : (pathMatch?.[1] ?? "");
        const fullPath = normalizePath(`${parentPath}/${ownPath}`);
        const sample = routePatternToSample(fullPath);
        if (sample) samples.add(sample);
        if (!/\/>\s*$/.test(line)) routeStack.push(fullPath);
        continue;
      }
    }

    if (line.includes("</Route>")) {
      routeStack.pop();
    }
  }

  return [...samples].sort();
}

function smokeRouteSamplesFromSpec(specSource: string): Set<string> {
  return new Set(
    [...specSource.matchAll(/["'](\/[^"']*)["']/g)]
      .map((match) => match[1] ?? "")
      .filter((route) => !route.includes(":"))
      .map((route) => normalizePath(route.split("?")[0] ?? route)),
  );
}

function sessionOnlyLiveDashboardRoutesFromSpec(
  specSource: string,
): Set<string> {
  const match = specSource.match(
    /LIVE_SESSION_ONLY_DASHBOARD_ROUTES\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (!match) return new Set();
  return new Set(
    [...(match[1] ?? "").matchAll(/["'](\/dashboard\/[^"']*)["']/g)].map(
      (entry) => normalizePath(entry[1] ?? ""),
    ),
  );
}

function stewardSessionLiveDashboardRoutesFromSpec(
  specSource: string,
): Set<string> {
  const match = specSource.match(
    /LIVE_STEWARD_SESSION_DASHBOARD_ROUTES\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (!match) return new Set();
  return new Set(
    [...(match[1] ?? "").matchAll(/["'](\/dashboard\/[^"']*)["']/g)].map(
      (entry) => normalizePath(entry[1] ?? ""),
    ),
  );
}

test("every cloud page component is reachable from the router", async () => {
  const appSource = readFileSync(APP_SOURCE, "utf8");
  const routeImports = lazyRouteImports(appSource);
  const pageComponents = [
    ...walkPageComponents(path.join(SRC_ROOT, "pages")),
    ...walkPageComponents(path.join(SRC_ROOT, "dashboard")),
  ];

  const missing = pageComponents
    .map((filePath) => ({
      filePath: path.relative(PACKAGE_ROOT, filePath),
      importPath: toAppImportPath(filePath),
    }))
    .filter(({ importPath }) => !routeImports.has(importPath));

  expect(
    missing,
    `These page components are not lazy-loaded by src/App.tsx:\n${missing
      .map(({ filePath, importPath }) => `  - ${filePath} (${importPath})`)
      .join("\n")}`,
  ).toEqual([]);
});

test("cloud route smoke covers every concrete router path", () => {
  const appSource = readFileSync(APP_SOURCE, "utf8");
  const smokeSource = readFileSync(CLOUD_ROUTES_SPEC, "utf8");
  const smokeRoutes = smokeRouteSamplesFromSpec(smokeSource);

  const missing = routerRouteSamples(appSource).filter(
    (route) => !smokeRoutes.has(route),
  );

  expect(
    missing,
    `Missing cloud route smoke coverage for: ${missing.join(", ")}`,
  ).toEqual([]);
});

test("live authenticated dashboard smoke covers every top-level dashboard page", () => {
  const appSource = readFileSync(APP_SOURCE, "utf8");
  const liveAuthSource = readFileSync(LIVE_AUTH_DASHBOARD_SPEC, "utf8");
  const liveStewardSource = readFileSync(
    LIVE_STEWARD_WALLET_LOGIN_SPEC,
    "utf8",
  );
  const liveAuthRoutes = smokeRouteSamplesFromSpec(liveAuthSource);
  const sessionOnlyRoutes =
    sessionOnlyLiveDashboardRoutesFromSpec(liveAuthSource);
  const stewardSessionRoutes =
    stewardSessionLiveDashboardRoutesFromSpec(liveStewardSource);

  const uncoveredSessionOnlyRoutes = [...sessionOnlyRoutes].filter(
    (route) => !stewardSessionRoutes.has(route),
  );
  expect(
    uncoveredSessionOnlyRoutes,
    `Session-only live dashboard routes must be covered by ${path.basename(
      LIVE_STEWARD_WALLET_LOGIN_SPEC,
    )}: ${uncoveredSessionOnlyRoutes.join(", ")}`,
  ).toEqual([]);

  const missing = routerRouteSamples(appSource).filter((route) => {
    if (!route.startsWith("/dashboard")) return false;
    if (route === "/dashboard/chat") return false;
    if (route.includes("/admin")) return false;
    const rest = route.replace(/^\/dashboard\/?/, "");
    if (sessionOnlyRoutes.has(route)) return false;
    if (!rest) return !liveAuthRoutes.has(route);
    if (rest.split("/").length > 1) return false;
    return !liveAuthRoutes.has(route);
  });

  expect(
    missing,
    `Missing live authenticated dashboard smoke coverage for: ${missing.join(
      ", ",
    )}`,
  ).toEqual([]);
});
