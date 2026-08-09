/**
 * AST contract for Node-side loopback requests. Every production fetch call
 * in the owning agent/app-control surfaces must either attach the shared
 * self-API bearer helper at that call site or match a reviewed protocol
 * exemption. A helper elsewhere in the same file cannot hide a bypass.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface SourceFile {
  path: string;
  source: string;
}

interface FetchSite {
  path: string;
  line: number;
  target: string;
  context: string;
  call: string;
}

interface ProtocolExemption {
  path: string;
  target: RegExp;
  protocol: string;
  rationale: string;
}

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const scanRoots = [
  "packages/agent/src",
  "plugins/plugin-app-control/src",
] as const;

const protocolExemptions: readonly ProtocolExemption[] = [
  {
    path: "packages/agent/src/actions/terminal.ts",
    target: /\/api\/terminal\/run/,
    protocol: "terminal-token",
    rationale:
      "The terminal boundary deliberately uses X-Eliza-Terminal-Token instead of self-API bearer auth.",
  },
  {
    path: "packages/agent/src/api/server-helpers-swarm.ts",
    target: /http:\/\/localhost:\$\{port\}\//,
    protocol: "port-liveness-probe",
    rationale:
      "The unauthenticated root request only detects whether a claimed swarm port is serving.",
  },
  {
    path: "packages/agent/src/api/diagnostics-routes.ts",
    target: /http:\/\/127\.0\.0\.1:\$\{relayPort\}\//,
    protocol: "diagnostics-relay-probe",
    rationale:
      "The unauthenticated HEAD request is a deliberate reachability probe for the diagnostics relay.",
  },
  {
    path: "packages/agent/src/api/cloud-pair-route.ts",
    target: /^exchangeUrl$/,
    protocol: "cloud-pairing-exchange",
    rationale:
      "The request posts a pairing code to the configured cloud relay rather than the local self-API.",
  },
  {
    path: "packages/agent/src/api/model-provider-helpers.ts",
    target: /\/api\/tags/,
    protocol: "ollama-model-api",
    rationale:
      "The localhost-compatible request targets the Ollama model protocol rather than the elizaOS self-API.",
  },
];

const expectedProtectedPaths = [
  "packages/agent/src/actions/logs.ts",
  "packages/agent/src/actions/plugin.ts",
  "packages/agent/src/actions/runtime.ts",
  "packages/agent/src/api/runtime-switch-routes.ts",
  "packages/agent/src/providers/page-scoped-live-state.ts",
  "packages/agent/src/runtime/custom-actions.ts",
  "plugins/plugin-app-control/src/actions/views-client.ts",
  "plugins/plugin-app-control/src/actions/views-show.ts",
  "plugins/plugin-app-control/src/services/verification-helpers.ts",
] as const;

const localTargetPattern =
  /127\.0\.0\.1|localhost|loopbackBase|getApiBase|getAppControlApiBase|getLocalApiUrls|resolveServerOnlyPort|resolveDesktopApiPort|ELIZA_PORT/;
const apiPathPattern = /\/api\//;
const knownSelfApiBasePattern =
  /loopbackBase|getApiBase|getAppControlApiBase|getLocalApiUrls|resolveServerOnlyPort|resolveDesktopApiPort/;
const authPrimitivePattern =
  /\b(?:createSelfApiRequestHeaders|createViewsRequestHeaders)\s*\(/;

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isProductionTypeScript(path: string): boolean {
  return (
    /\.tsx?$/.test(path) &&
    !/\.(?:test|spec)\.tsx?$/.test(path) &&
    !path.includes("/__fixtures__/")
  );
}

function collectSourceFiles(rootPath: string): SourceFile[] {
  const absoluteRoot = resolve(repoRoot, rootPath);
  if (/\.tsx?$/.test(rootPath)) {
    return [{ path: rootPath, source: readFileSync(absoluteRoot, "utf8") }];
  }

  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const path = normalizePath(relative(repoRoot, absolutePath));
      if (!isProductionTypeScript(path)) continue;
      files.push({ path, source: readFileSync(absolutePath, "utf8") });
    }
  };
  visit(absoluteRoot);
  return files;
}

function isFetchCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ["fetch", "fetchImpl", "fetchWithTimeout"].includes(node.expression.text)
  );
}

function nearestFunction(node: ts.Node): ts.Node {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

function collectFetchSites(file: SourceFile): FetchSite[] {
  const sourceFile = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites: FetchSite[] = [];
  const visit = (node: ts.Node): void => {
    if (isFetchCall(node)) {
      const target = node.arguments[0]?.getText(sourceFile) ?? "";
      sites.push({
        path: file.path,
        line:
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1,
        target,
        context: nearestFunction(node).getText(sourceFile),
        call: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function isProtectedSelfApiSite(site: FetchSite): boolean {
  const evidence = `${site.target}\n${site.context}`;
  return (
    localTargetPattern.test(evidence) &&
    (apiPathPattern.test(evidence) || knownSelfApiBasePattern.test(evidence))
  );
}

function matchingExemption(site: FetchSite): ProtocolExemption | undefined {
  return protocolExemptions.find(
    (exemption) =>
      exemption.path === site.path && exemption.target.test(site.target),
  );
}

function findContractViolations(sites: readonly FetchSite[]): string[] {
  return sites
    .filter(isProtectedSelfApiSite)
    .filter(
      (site) =>
        !authPrimitivePattern.test(site.call) && !matchingExemption(site),
    )
    .map((site) => `${site.path}:${site.line}`)
    .sort();
}

describe("self-API loopback authentication contract", () => {
  const productionSources = scanRoots.flatMap(collectSourceFiles);
  const productionSites = productionSources.flatMap(collectFetchSites);

  it("classifies every protected production fetch call independently", () => {
    expect(findContractViolations(productionSites)).toEqual([]);
    const protectedPaths = new Set(
      productionSites.filter(isProtectedSelfApiSite).map((site) => site.path),
    );
    for (const path of expectedProtectedPaths) {
      expect(protectedPaths.has(path), `${path} must remain inventoried`).toBe(
        true,
      );
    }
  });

  it("keeps every exemption reviewable with a named protocol and rationale", () => {
    for (const exemption of protocolExemptions) {
      const site = productionSites.find(
        (candidate) =>
          candidate.path === exemption.path &&
          exemption.target.test(candidate.target),
      );
      expect(
        site,
        `${exemption.path} must retain its explicitly classified protocol call`,
      ).toBeDefined();
      expect(exemption.protocol.trim().length).toBeGreaterThan(0);
      expect(exemption.rationale.trim().length).toBeGreaterThan(20);
    }
  });

  it("records the terminal-token and unauthenticated port-probe boundaries by protocol", () => {
    expect(protocolExemptions.map(({ protocol }) => protocol)).toEqual(
      expect.arrayContaining(["terminal-token", "port-liveness-probe"]),
    );
  });

  it("turns red for a synthetic bypass beside an authenticated call", () => {
    const synthetic = collectFetchSites({
      path: "packages/agent/src/actions/synthetic-bypass.ts",
      source: `
        async function searchLogs() {
          const base = "http://127.0.0.1:3000";
          await fetch(base + "/api/logs", {
            headers: createSelfApiRequestHeaders(),
          });
          await fetch(base + "/api/plugins");
        }
      `,
    });

    expect(synthetic).toHaveLength(2);
    expect(findContractViolations(synthetic)).toEqual([
      "packages/agent/src/actions/synthetic-bypass.ts:7",
    ]);
  });
});
