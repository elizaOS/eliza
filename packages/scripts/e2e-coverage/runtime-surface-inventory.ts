/**
 * Builds the canonical synthetic-world inventory from production registration
 * objects and host manifests. The extractor follows typed `Plugin` objects,
 * their spreads, imported arrays, promoted subactions, Cloud route modules,
 * Worker bindings, native bridge registration calls, and maintained service
 * package entry points without importing application code or running provider
 * side effects.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

export const RUNTIME_SURFACE_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const RUNTIME_SURFACE_SCHEMA = "eliza.synthetic-world-surfaces/v1";
export const RUNTIME_DEPENDENCY_SCHEMA =
  "eliza.synthetic-world-dependencies/v1";

export const RUNTIME_SURFACE_STATUSES = [
  "covered",
  "uncovered",
  "exempt",
  "platform-deferred",
  "provider-qualified-only",
  "unsupported-product",
] as const;

export type RuntimeSurfaceStatus = (typeof RUNTIME_SURFACE_STATUSES)[number];

export const RUNTIME_SURFACE_KINDS = [
  "action",
  "subaction",
  "provider",
  "service",
  "evaluator",
  "response-handler-evaluator",
  "response-handler-field-evaluator",
  "event-handler",
  "route",
  "view",
  "model-handler",
  "connector-ingress",
  "connector-egress",
  "scheduled-worker",
  "queue",
  "native-bridge",
  "cloud-service",
] as const;

export type RuntimeSurfaceKind = (typeof RUNTIME_SURFACE_KINDS)[number];

export type MockAvailability = "available" | "partial" | "missing";
export type ResetSupport = "supported" | "partial" | "missing";

export interface ExternalServiceDependency {
  id: string;
  protocol: string;
}

export interface MockDependency {
  serviceId: string;
  availability: "available" | "missing";
  owner: string | null;
  source: string | null;
  reason: string;
}

export interface RuntimeDependencyRule {
  packageName: string;
  kinds: RuntimeSurfaceKind[];
  /** Exact canonical ids override a package/kind rule for narrower truth. */
  surfaceIds?: string[];
  /** Canonical-id and source selectors narrow a rule to evidenced surfaces. */
  surfaceIdPrefixes?: string[];
  sourcePathPrefixes?: string[];
  noExternalServiceReason?: string;
  unresolvedDependencyReason?: string;
  externalServices?: Array<{
    id: string;
    protocol: string;
    mockOwner?: string;
    mockSource?: string;
    mockContract?: {
      kind: "mockoon-http";
      operations: Array<{
        method: string;
        path: string;
      }>;
    };
    missingMockReason?: string;
  }>;
}

export interface RuntimeDependencyCatalog {
  schema: typeof RUNTIME_DEPENDENCY_SCHEMA;
  upstreamCatalog: {
    pullRequest: number;
    head: string;
    path: string;
    relationship: string;
  };
  rules: RuntimeDependencyRule[];
  /** Reviewed package boundaries that do not call an external service. */
  localPackages: Record<string, string>;
}

const MOCKOON_HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

function canonicalMockoonPath(...parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

/** Parses only registered Mockoon HTTP routes with one executable default response. */
export function parseMockoonHttpOperations(
  fixture: unknown,
  serviceId: string,
): Set<string> {
  if (!fixture || typeof fixture !== "object") {
    throw new Error(`${serviceId} mockSource is not a Mockoon environment`);
  }
  const environment = fixture as {
    endpointPrefix?: unknown;
    folders?: unknown;
    rootChildren?: unknown;
    routes?: unknown;
  };
  if (
    typeof environment.endpointPrefix !== "string" ||
    !Array.isArray(environment.routes) ||
    !Array.isArray(environment.rootChildren) ||
    (environment.folders !== undefined &&
      (!Array.isArray(environment.folders) || environment.folders.length > 0))
  ) {
    throw new Error(
      `${serviceId} mockSource requires flat registered Mockoon HTTP routes`,
    );
  }

  const registeredRouteIds = new Set<string>();
  for (const child of environment.rootChildren) {
    if (!child || typeof child !== "object") {
      throw new Error(`${serviceId} has an invalid Mockoon route registration`);
    }
    const candidate = child as { type?: unknown; uuid?: unknown };
    if (
      candidate.type !== "route" ||
      typeof candidate.uuid !== "string" ||
      candidate.uuid.trim().length === 0 ||
      registeredRouteIds.has(candidate.uuid)
    ) {
      throw new Error(`${serviceId} has an invalid Mockoon route registration`);
    }
    registeredRouteIds.add(candidate.uuid);
  }

  const routeIds = new Set<string>();
  const operations = new Set<string>();
  for (const route of environment.routes) {
    if (!route || typeof route !== "object") {
      throw new Error(`${serviceId} has an invalid Mockoon route`);
    }
    const candidate = route as {
      uuid?: unknown;
      type?: unknown;
      method?: unknown;
      endpoint?: unknown;
      responses?: unknown;
    };
    const method =
      typeof candidate.method === "string"
        ? candidate.method.trim().toUpperCase()
        : "";
    const uuid =
      typeof candidate.uuid === "string" ? candidate.uuid.trim() : "";
    const endpoint =
      typeof candidate.endpoint === "string"
        ? canonicalMockoonPath(environment.endpointPrefix, candidate.endpoint)
        : "";
    const responses = Array.isArray(candidate.responses)
      ? candidate.responses
      : [];
    const validResponses = responses.filter((response) => {
      if (!response || typeof response !== "object") return false;
      const value = response as {
        uuid?: unknown;
        statusCode?: unknown;
        default?: unknown;
        body?: unknown;
        bodyType?: unknown;
      };
      return (
        typeof value.uuid === "string" &&
        value.uuid.trim().length > 0 &&
        Number.isInteger(value.statusCode) &&
        (value.statusCode as number) >= 100 &&
        (value.statusCode as number) <= 599 &&
        typeof value.default === "boolean" &&
        value.bodyType === "INLINE" &&
        typeof value.body === "string"
      );
    });
    if (
      candidate.type !== "http" ||
      !uuid ||
      routeIds.has(uuid) ||
      !registeredRouteIds.has(uuid) ||
      !MOCKOON_HTTP_METHODS.has(method) ||
      !endpoint ||
      validResponses.length !== responses.length ||
      validResponses.filter(
        (response) => (response as { default: boolean }).default,
      ).length !== 1
    ) {
      throw new Error(`${serviceId} has an unserved Mockoon HTTP route`);
    }
    routeIds.add(uuid);
    const operation = `${method} ${endpoint}`;
    if (operations.has(operation)) {
      throw new Error(`${serviceId} has a duplicate Mockoon HTTP operation`);
    }
    operations.add(operation);
  }
  if (
    routeIds.size !== registeredRouteIds.size ||
    ![...registeredRouteIds].every((uuid) => routeIds.has(uuid))
  ) {
    throw new Error(`${serviceId} has an orphan Mockoon route registration`);
  }
  return operations;
}

export interface RuntimeSurfaceRow {
  id: string;
  kind: RuntimeSurfaceKind;
  surfaceName: string;
  owner: string;
  packageName: string;
  packageDir: string;
  sourcePath: string;
  registrationField: string;
  runtimeRequirements: string[];
  platformRequirements: string[];
  packageDependencies: string[];
  externalServiceDependencies: ExternalServiceDependency[];
  mockDependencies: MockDependency[];
  dependencyDisposition:
    | "local-only"
    | "mock-owned"
    | "mock-missing"
    | "unresolved";
  mockAvailability: MockAvailability;
  mockFidelity: string;
  resetSupport: ResetSupport;
  deterministicScenarioIds: string[];
  liveModelScenarioIds: string[];
  cloudE2eCells: string[];
  evidenceClass: "synthetic" | "provider-qualified" | "none";
  boundaryArtifacts: string[];
  boundarySignals: string[];
  workstream:
    | "#22898"
    | "#22899"
    | "#22901"
    | "#22902"
    | "#22904"
    | "#23268"
    | "#23270";
  status: RuntimeSurfaceStatus;
  reason: string;
}

export interface RuntimeSurfaceInventory {
  schema: typeof RUNTIME_SURFACE_SCHEMA;
  generatedAt: string;
  sourceRevision: string;
  packages: RuntimePackageRecord[];
  rows: RuntimeSurfaceRow[];
  summary: {
    total: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    byDependencyDisposition: Record<string, number>;
  };
  gaps: {
    byOwner: Record<string, string[]>;
    byExternalService: Record<string, string[]>;
    byMockOwner: Record<string, string[]>;
    byScenarioLane: Record<string, string[]>;
    byWorkstream: Record<string, string[]>;
  };
}

export interface RuntimePackageRecord {
  owner: string;
  packageName: string;
  packageDir: string;
  runtimeRequirements: string[];
  platformRequirements: string[];
  packageDependencies: string[];
  registeredSurfaceIds: string[];
  registrationState: "registered-surfaces" | "no-runtime-registration";
  reason: string;
}

interface PackageContext {
  dir: string;
  packageName: string;
  owner: string;
  runtimeRequirements: string[];
  platformRequirements: string[];
  packageDependencies: string[];
}

interface RawSurface {
  kind: RuntimeSurfaceKind;
  name: string;
  sourcePath: string;
  registrationField: string;
  package: PackageContext;
}

interface ScenarioRecord {
  id: string;
  file: string;
  source: string;
  plugins: string[];
  runtimeSurfaceIds: string[];
  lane: "deterministic" | "live";
}

interface SourceUnit {
  file: string;
  source: string;
  ast: ts.SourceFile;
  declarations: Map<string, ts.Node>;
  imports: Map<string, { imported: string; file: string }>;
}

interface ExtractionContext {
  units: Map<string, SourceUnit>;
  seen: Set<string>;
}

const EVIDENCE_AST_CACHE = new Map<string, ts.SourceFile>();
let WORKSPACE_PACKAGE_DIRS_BY_NAME: Map<string, string> | null = null;
const RESOLVED_IDENTIFIER_HINTS = new Map<
  string,
  { file: string; declarationName: string }
>();
const RESOLVED_WORKSPACE_SYMBOLS = new Map<
  string,
  { file: string; declarationName: string } | null
>();
const SCENARIO_METADATA_CACHE = new Map<
  string,
  {
    id: string | null;
    plugins: string[];
    runtimeSurfaceIds: string[];
    lane: string | null;
  }
>();

const PLUGIN_FIELDS = new Map<string, RuntimeSurfaceKind>([
  ["actions", "action"],
  ["providers", "provider"],
  ["services", "service"],
  ["evaluators", "evaluator"],
  ["responseHandlerEvaluators", "response-handler-evaluator"],
  ["responseHandlerFieldEvaluators", "response-handler-field-evaluator"],
  ["events", "event-handler"],
  ["routes", "route"],
  ["views", "view"],
  ["models", "model-handler"],
  ["connectorSources", "connector-ingress"],
]);

const NAME_KEYS: Record<RuntimeSurfaceKind, readonly string[]> = {
  action: ["name"],
  subaction: ["name"],
  provider: ["name"],
  service: ["serviceType", "name"],
  evaluator: ["name"],
  "response-handler-evaluator": ["name"],
  "response-handler-field-evaluator": ["name"],
  "event-handler": ["eventName", "name"],
  route: ["path", "name"],
  view: ["id", "path", "label", "name"],
  "model-handler": ["modelType", "name"],
  "connector-ingress": ["source", "name"],
  "connector-egress": ["source", "name"],
  "scheduled-worker": ["name", "id"],
  queue: ["queue", "name", "binding"],
  "native-bridge": ["name", "id"],
  "cloud-service": ["name"],
};

const EXECUTABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

/**
 * Production hosts whose boot entry is owned by deployment tooling rather than
 * a package export. Keep this list narrow and source-backed: adding a filename
 * convention here would make an unexported implementation look executable.
 */
const DOCUMENTED_HOST_BOOT_ENTRYPOINTS: Readonly<Record<string, string[]>> = {
  "@elizaos/operator": ["pepr.ts"],
};

function walkFiles(
  root: string,
  predicate: (file: string) => boolean,
): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === "build" ||
        entry === ".turbo" ||
        entry === "coverage"
      ) {
        continue;
      }
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) visit(full);
      else if (predicate(full)) files.push(full);
    }
  };
  visit(root);
  return files;
}

function isProductionTypeScript(file: string): boolean {
  if (
    !/\.(?:ts|tsx)$/.test(file) ||
    /\.(?:test|spec)\.(?:ts|tsx)$/.test(file)
  ) {
    return false;
  }
  const segments = file.split(path.sep);
  return !segments.some((segment) =>
    ["__tests__", "test", "tests", "fixtures"].includes(segment),
  );
}

function toRepoPath(file: string): string {
  return path
    .relative(RUNTIME_SURFACE_REPO_ROOT, file)
    .split(path.sep)
    .join("/");
}

function normalizeName(value: string): string {
  const normalized = value
    .replace(/^['"`]|['"`]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "anonymous";
}

function stableToken(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("*", "star")
    .replace(/[^a-z0-9._:/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
}

/** Builds the canonical identity without coupling it to a movable source file. */
export function runtimeSurfaceId(surface: {
  kind: RuntimeSurfaceKind;
  name: string;
  package: { packageName: string };
}): string {
  return [
    surface.package.packageName,
    surface.kind,
    stableToken(surface.name),
  ].join(":");
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function collectExportConditions(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (["node", "bun", "browser", "worker", "react-native"].includes(key)) {
      out.add(key);
    }
    collectExportConditions(nested, out);
  }
}

function packageContext(packageDir: string): PackageContext | null {
  const file = path.join(packageDir, "package.json");
  if (!existsSync(file)) return null;
  const manifest = readJson(file);
  if (typeof manifest.name !== "string") return null;
  const runtime = new Set<string>();
  collectExportConditions(manifest.exports, runtime);
  const engines = manifest.engines;
  if (engines && typeof engines === "object" && !Array.isArray(engines)) {
    for (const [name, version] of Object.entries(engines)) {
      if (typeof version === "string") runtime.add(`${name}${version}`);
    }
  }
  const platforms = new Set<string>([
    ...strings(manifest.os),
    ...strings(manifest.cpu).map((cpu) => `cpu:${cpu}`),
  ]);
  const rel = toRepoPath(packageDir);
  if (rel.includes("plugin-native-") || rel.startsWith("packages/native/")) {
    platforms.add("native-host");
  }
  const dependencyObjects = [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  const dependencies = new Set<string>();
  for (const object of dependencyObjects) {
    if (!object || typeof object !== "object" || Array.isArray(object))
      continue;
    for (const name of Object.keys(object)) {
      if (!name.startsWith("@elizaos/") && name !== "elizaos") {
        dependencies.add(name);
      }
    }
  }
  return {
    dir: rel,
    packageName: manifest.name,
    owner: manifest.name,
    runtimeRequirements: [...runtime].sort(),
    platformRequirements: [...platforms].sort(),
    packageDependencies: [...dependencies].sort(),
  };
}

export function loadRuntimeDependencyCatalog(
  file = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "runtime-surface-dependencies.json",
  ),
): RuntimeDependencyCatalog {
  const parsed = readJson(file) as unknown as RuntimeDependencyCatalog;
  if (
    parsed.schema !== RUNTIME_DEPENDENCY_SCHEMA ||
    !Array.isArray(parsed.rules) ||
    !parsed.localPackages ||
    typeof parsed.localPackages !== "object" ||
    Array.isArray(parsed.localPackages) ||
    !parsed.upstreamCatalog ||
    typeof parsed.upstreamCatalog !== "object"
  ) {
    throw new Error(`Invalid runtime dependency catalog schema in ${file}`);
  }
  return parsed;
}

function validateDependencyRule(rule: RuntimeDependencyRule): void {
  if (
    !Array.isArray(rule.kinds) ||
    rule.kinds.length === 0 ||
    new Set(rule.kinds).size !== rule.kinds.length
  ) {
    throw new Error(
      `${rule.packageName} dependency rule requires unique explicit kinds`,
    );
  }
  for (const [selector, values] of [
    ["surfaceIds", rule.surfaceIds],
    ["surfaceIdPrefixes", rule.surfaceIdPrefixes],
    ["sourcePathPrefixes", rule.sourcePathPrefixes],
  ] as const) {
    if (
      values &&
      (values.length === 0 || values.some((value) => !value.trim()))
    ) {
      throw new Error(
        `${rule.packageName} dependency rule has an empty ${selector} selector`,
      );
    }
  }
  if (
    rule.sourcePathPrefixes?.some(
      (prefix) =>
        path.isAbsolute(prefix) ||
        prefix.split(/[\\/]/).includes("..") ||
        prefix.startsWith("./"),
    )
  ) {
    throw new Error(
      `${rule.packageName} dependency rule has a non-canonical sourcePathPrefixes selector`,
    );
  }
  if (
    !rule.packageName ||
    (Array.isArray(rule.kinds) && rule.kinds.length === 0)
  ) {
    throw new Error(
      "Runtime dependency rules require a package and at least one kind",
    );
  }
  const hasLocalReason = typeof rule.noExternalServiceReason === "string";
  const hasUnresolvedReason =
    typeof rule.unresolvedDependencyReason === "string";
  const services = rule.externalServices ?? [];
  if (
    Number(hasLocalReason) +
      Number(hasUnresolvedReason) +
      Number(services.length > 0) !==
    1
  ) {
    throw new Error(
      `${rule.packageName} dependency rule must declare exactly one disposition`,
    );
  }
  if (
    hasLocalReason &&
    (rule.noExternalServiceReason?.trim().length ?? 0) < 24
  ) {
    throw new Error(
      `${rule.packageName} local-only dependency reason is not actionable`,
    );
  }
  if (
    hasUnresolvedReason &&
    (rule.unresolvedDependencyReason?.trim().length ?? 0) < 24
  ) {
    throw new Error(
      `${rule.packageName} unresolved dependency reason is not actionable`,
    );
  }
  const serviceIds = new Set<string>();
  for (const service of services) {
    if (!service.id || !service.protocol || serviceIds.has(service.id)) {
      throw new Error(
        `${rule.packageName} has an invalid or duplicate service dependency`,
      );
    }
    serviceIds.add(service.id);
    const hasMock = Boolean(service.mockOwner || service.mockSource);
    if (hasMock && (!service.mockOwner || !service.mockSource)) {
      throw new Error(
        `${service.id} must declare both mockOwner and mockSource`,
      );
    }
    if (
      hasMock &&
      (!rule.surfaceIds?.length ||
        Boolean(rule.surfaceIdPrefixes?.length) ||
        Boolean(rule.sourcePathPrefixes?.length))
    ) {
      throw new Error(`${service.id} mock ownership requires exact surfaceIds`);
    }
    if (hasMock && service.mockContract?.kind !== "mockoon-http") {
      throw new Error(
        `${service.id} requires a parsed Mockoon HTTP operation contract`,
      );
    }
    const operations = service.mockContract?.operations ?? [];
    const operationKeys = operations.map(
      (operation) =>
        `${operation.method.trim().toUpperCase()} ${operation.path
          .trim()
          .replace(/^\/+/, "")}`,
    );
    if (
      hasMock &&
      (operations.length === 0 ||
        operationKeys.some((operation) => !/^[A-Z]+ \S+$/.test(operation)) ||
        new Set(operationKeys).size !== operationKeys.length)
    ) {
      throw new Error(
        `${service.id} requires unique canonical HTTP operations`,
      );
    }
    if (hasMock && service.missingMockReason) {
      throw new Error(
        `${service.id} cannot be both mock-owned and mock-missing`,
      );
    }
    if (!hasMock && (service.missingMockReason?.trim().length ?? 0) < 24) {
      throw new Error(`${service.id} requires an actionable missingMockReason`);
    }
    if (service.mockSource) {
      const source = path.resolve(
        RUNTIME_SURFACE_REPO_ROOT,
        service.mockSource,
      );
      const relative = path.relative(RUNTIME_SURFACE_REPO_ROOT, source);
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        !existsSync(source)
      ) {
        throw new Error(
          `${service.id} mockSource is missing or escapes the repository`,
        );
      }
      let fixture: unknown;
      try {
        fixture = JSON.parse(readFileSync(source, "utf8"));
      } catch (cause) {
        throw new Error(`${service.id} mockSource is not valid JSON`, {
          cause,
        });
      }
      const registeredOperations = parseMockoonHttpOperations(
        fixture,
        service.id,
      );
      for (const operation of operationKeys) {
        if (!registeredOperations.has(operation)) {
          throw new Error(
            `${service.id} mockSource does not register HTTP operation ${operation}`,
          );
        }
      }
    }
  }
}

function dependencyRuleMatches(
  rule: RuntimeDependencyRule,
  kind: RuntimeSurfaceKind,
  surfaceId?: string,
  sourcePath?: string,
): boolean {
  if (!rule.kinds.includes(kind)) return false;
  if (rule.surfaceIds && (!surfaceId || !rule.surfaceIds.includes(surfaceId)))
    return false;
  if (
    rule.surfaceIdPrefixes &&
    (!surfaceId ||
      !rule.surfaceIdPrefixes.some((prefix) => surfaceId.startsWith(prefix)))
  )
    return false;
  if (
    rule.sourcePathPrefixes &&
    (!sourcePath ||
      !rule.sourcePathPrefixes.some((prefix) => sourcePath.startsWith(prefix)))
  )
    return false;
  return true;
}

export function resolveRuntimeDependencies(
  packageName: string,
  kind: RuntimeSurfaceKind,
  catalog: RuntimeDependencyCatalog = loadRuntimeDependencyCatalog(),
  surfaceId?: string,
  sourcePath?: string,
): {
  externalServiceDependencies: ExternalServiceDependency[];
  mockDependencies: MockDependency[];
  dependencyDisposition: RuntimeSurfaceRow["dependencyDisposition"];
} {
  const matches = catalog.rules.filter(
    (rule) =>
      rule.packageName === packageName &&
      dependencyRuleMatches(rule, kind, surfaceId, sourcePath),
  );
  const specificMatches = matches.filter(
    (rule) =>
      rule.surfaceIds || rule.surfaceIdPrefixes || rule.sourcePathPrefixes,
  );
  const selected = specificMatches.length > 0 ? specificMatches : matches;
  if (selected.length === 0) {
    return {
      externalServiceDependencies: [],
      mockDependencies: [],
      dependencyDisposition: "unresolved",
    };
  }
  if (selected.length !== 1) {
    throw new Error(
      `${packageName}:${kind} requires exactly one explicit runtime dependency rule; found ${selected.length}`,
    );
  }
  const rule = selected[0];
  validateDependencyRule(rule);
  if (rule.unresolvedDependencyReason) {
    return {
      externalServiceDependencies: [],
      mockDependencies: [],
      dependencyDisposition: "unresolved",
    };
  }
  const services = rule.externalServices ?? [];
  const mockDependencies: MockDependency[] = services.map((service) => {
    if (service.mockOwner && service.mockSource) {
      return {
        serviceId: service.id,
        availability: "available",
        owner: service.mockOwner,
        source: service.mockSource,
        reason: `${service.mockOwner} owns the ${service.protocol} mock source at ${service.mockSource}; row-level reset proof remains separate.`,
      };
    }
    if (!service.missingMockReason) {
      throw new Error(`${service.id} requires an actionable missingMockReason`);
    }
    return {
      serviceId: service.id,
      availability: "missing",
      owner: null,
      source: null,
      reason: service.missingMockReason,
    };
  });
  return {
    externalServiceDependencies: services.map(({ id, protocol }) => ({
      id,
      protocol,
    })),
    mockDependencies,
    dependencyDisposition:
      services.length === 0
        ? "local-only"
        : mockDependencies.every(
              (dependency) => dependency.availability === "available",
            )
          ? "mock-owned"
          : "mock-missing",
  };
}

export function validateRuntimeDependencyCatalog(
  surfaces: ReadonlyArray<{
    packageName: string;
    kind: RuntimeSurfaceKind;
    id?: string;
    sourcePath?: string;
  }>,
  catalog: RuntimeDependencyCatalog = loadRuntimeDependencyCatalog(),
): void {
  for (const rule of catalog.rules) validateDependencyRule(rule);
  const availableIds = new Set(
    surfaces
      .map((surface) => surface.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const exactIds = new Set<string>();
  for (const rule of catalog.rules.filter(
    (candidate) => candidate.surfaceIds,
  )) {
    for (const id of rule.surfaceIds ?? []) {
      if (exactIds.has(id)) {
        throw new Error(`duplicate exact runtime dependency rule: ${id}`);
      }
      exactIds.add(id);
      if (availableIds.size > 0 && !availableIds.has(id)) {
        throw new Error(`stale exact runtime dependency rule: ${id}`);
      }
      if (!id.startsWith(`${rule.packageName}:`)) {
        throw new Error(
          `${id} does not belong to dependency package ${rule.packageName}`,
        );
      }
    }
  }
  if (Object.keys(catalog.localPackages).length > 0) {
    throw new Error(
      "localPackages is retired; local-only dispositions require an explicit matching rule",
    );
  }
  const duplicate: string[] = [];
  for (const surface of surfaces) {
    const selector = surface.id ?? `${surface.packageName}:${surface.kind}`;
    const matches = catalog.rules.filter(
      (rule) =>
        rule.packageName === surface.packageName &&
        dependencyRuleMatches(
          rule,
          surface.kind,
          surface.id,
          surface.sourcePath,
        ),
    );
    const specific = matches.filter(
      (rule) =>
        rule.surfaceIds || rule.surfaceIdPrefixes || rule.sourcePathPrefixes,
    );
    const selected = specific.length > 0 ? specific : matches;
    if (selected.length > 1) {
      duplicate.push(selector);
    }
  }
  for (const rule of catalog.rules) {
    const matched = surfaces.some(
      (surface) =>
        surface.packageName === rule.packageName &&
        dependencyRuleMatches(
          rule,
          surface.kind,
          surface.id,
          surface.sourcePath,
        ),
    );
    if (!matched) {
      throw new Error(`stale=${rule.packageName}:${rule.kinds.join(",")}`);
    }
  }
  if (duplicate.length > 0) {
    throw new Error(
      [
        duplicate.length > 0
          ? `duplicate=${[...new Set(duplicate)].sort().join(",")}`
          : null,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }
}

function resolveModule(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  const withoutJs = base.replace(/\.(?:m?js|cjs)$/, "");
  const candidates = [
    base,
    ...EXECUTABLE_EXTENSIONS.map((ext) => `${withoutJs}${ext}`),
    ...EXECUTABLE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
}

function resolveWorkspaceModule(specifier: string): string | null {
  WORKSPACE_PACKAGE_DIRS_BY_NAME ??= new Map(
    workspacePackageDirs().flatMap((dir) => {
      const name = readJson(path.join(dir, "package.json")).name;
      return typeof name === "string" ? [[name, dir] as const] : [];
    }),
  );
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  const packageDir = WORKSPACE_PACKAGE_DIRS_BY_NAME.get(packageName);
  if (!packageDir) return null;
  const subpath = specifier.slice(packageName.length).replace(/^\//, "");
  const bases = subpath
    ? [path.join(packageDir, "src", subpath), path.join(packageDir, subpath)]
    : [path.join(packageDir, "src", "index"), path.join(packageDir, "index")];
  const candidates = bases.flatMap((base) => [
    ...EXECUTABLE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...EXECUTABLE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ]);
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
}

export function packageEntryPoints(packageDir: string): string[] {
  const candidates = new Set<string>();
  const manifest = readJson(path.join(packageDir, "package.json"));
  const rootExport =
    manifest.exports && typeof manifest.exports === "object"
      ? (manifest.exports as Record<string, unknown>)["."]
      : manifest.exports;
  const hasRootSourceCondition =
    rootExport &&
    typeof rootExport === "object" &&
    !Array.isArray(rootExport) &&
    "eliza-source" in (rootExport as Record<string, unknown>);
  const hasExplicitSource =
    typeof manifest.source === "string" || hasRootSourceCondition;
  const visit = (value: unknown, preferSourceCondition = true): void => {
    if (typeof value === "string") {
      const normalized = value.replace(/^\.\//, "");
      if (
        /^dist\/.*\.(?:m?js|cjs)$/.test(normalized) &&
        !normalized.includes("*")
      ) {
        const outputStem = normalized
          .replace(/^dist\//, "")
          .replace(/\.(?:m?js|cjs)$/, "");
        const sourceGroups = [[path.join("src", outputStem), outputStem]];
        const basename = path.basename(outputStem);
        if (outputStem === "index") {
          if (hasExplicitSource) return;
          const inferredIndexes = [path.join("src", "index"), "index"].flatMap(
            (stem) =>
              [".ts", ".tsx", ".mts", ".cts"]
                .map((extension) =>
                  path.join(packageDir, `${stem}${extension}`),
                )
                .filter((file) => existsSync(file)),
          );
          if (inferredIndexes.length > 1) {
            throw new Error(
              `${manifest.name ?? packageDir} has ambiguous dist/index.js source authority: ${inferredIndexes
                .map((file) => path.relative(packageDir, file))
                .join(", ")}`,
            );
          }
          if (inferredIndexes[0]) candidates.add(inferredIndexes[0]);
          return;
        }
        if (/^index\.(?:browser|node|edge)$/.test(basename)) {
          sourceGroups.push([path.join("src", basename), basename]);
        }
        for (const stems of sourceGroups) {
          const alternatives: string[] = [];
          for (const stem of stems) {
            for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
              alternatives.push(path.join(packageDir, `${stem}${extension}`));
            }
          }
          const sourceFile = alternatives.find((file) => existsSync(file));
          if (sourceFile) {
            candidates.add(sourceFile);
            break;
          }
        }
      }
      if (
        /\.(?:ts|tsx|mts|cts)$/.test(normalized) &&
        !/(?:^|\/)dist\//.test(normalized) &&
        !/\.d\.(?:ts|mts|cts)$/.test(normalized)
      ) {
        const file = path.join(packageDir, normalized);
        if (existsSync(file)) candidates.add(file);
      }
      return;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (preferSourceCondition && record["eliza-source"]) {
        visit(record["eliza-source"], preferSourceCondition);
        return;
      }
      for (const child of Object.values(record))
        visit(child, preferSourceCondition);
    }
  };
  visit(manifest.exports);
  visit(manifest.bin);
  visit(manifest.source);
  if (!hasExplicitSource) {
    visit(manifest.main, false);
    visit(manifest.module, false);
  }
  const scripts = manifest.scripts;
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    const start = (scripts as Record<string, unknown>).start;
    if (typeof start === "string") {
      for (const match of start.matchAll(
        /(?:^|\s)([^\s"']+\.(?:ts|tsx|mts|cts))(?:\s|$)/g,
      )) {
        const file = path.join(packageDir, match[1].replace(/^\.\//, ""));
        if (existsSync(file)) candidates.add(file);
      }
    }
  }
  if (typeof manifest.name === "string") {
    for (const entrypoint of DOCUMENTED_HOST_BOOT_ENTRYPOINTS[manifest.name] ??
      []) {
      const file = path.join(packageDir, entrypoint);
      if (existsSync(file)) candidates.add(file);
    }
  }
  return [...candidates].sort();
}

export function reachableProductionFiles(packageDir: string): string[] {
  const reached = new Set<string>();
  const pending = [...packageEntryPoints(packageDir)];
  while (pending.length > 0) {
    const file = path.resolve(pending.pop() as string);
    if (
      reached.has(file) ||
      !file.startsWith(`${packageDir}${path.sep}`) ||
      !isProductionTypeScript(file)
    )
      continue;
    reached.add(file);
    const ast = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      let specifier: string | null = null;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifier = node.moduleSpecifier.text;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specifier = node.arguments[0].text;
      }
      if (specifier) {
        const resolved = resolveModule(file, specifier);
        if (resolved?.startsWith(`${packageDir}${path.sep}`))
          pending.push(resolved);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return [...reached].sort();
}

function unitFor(file: string, units: Map<string, SourceUnit>): SourceUnit {
  const absolute = path.resolve(file);
  const cached = units.get(absolute);
  if (cached) return cached;
  const source = readFileSync(absolute, "utf8");
  const ast = ts.createSourceFile(
    absolute,
    source,
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const declarations = new Map<string, ts.Node>();
  const imports = new Map<string, { imported: string; file: string }>();
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          declarations.set(declaration.name.text, declaration);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      declarations.set(statement.name.text, statement);
    } else if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const target = resolveModule(absolute, statement.moduleSpecifier.text);
      if (!target || !statement.importClause) continue;
      if (statement.importClause.name) {
        imports.set(statement.importClause.name.text, {
          imported: "default",
          file: target,
        });
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imports.set(element.name.text, {
            imported: element.propertyName?.text ?? element.name.text,
            file: target,
          });
        }
      }
    }
  }
  const unit = { file: absolute, source, ast, declarations, imports };
  units.set(absolute, unit);
  return unit;
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (!node) return null;
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    const expression = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isIdentifier(expression)) return expression.text;
    return literalText(expression);
  }
  return null;
}

function resolvedPropertyName(
  node: ts.PropertyName | undefined,
  unit: SourceUnit,
  context: ExtractionContext,
): string | null {
  if (node && ts.isComputedPropertyName(node)) {
    return resolvedScalar(node.expression, unit, context);
  }
  return propertyName(node);
}

function literalText(node: ts.Node): string | null {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function pluginTyped(node: ts.Node): boolean {
  if (ts.isVariableDeclaration(node)) {
    const type = node.type?.getText() ?? "";
    if (/(?:^|\W)Plugin(?:\W|$)/.test(type)) return true;
    if (node.initializer && ts.isSatisfiesExpression(node.initializer)) {
      return /(?:^|\W)Plugin(?:\W|$)/.test(node.initializer.type.getText());
    }
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    return /(?:^|\W)Plugin(?:\W|$)/.test(node.type?.getText() ?? "");
  }
  return false;
}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function resolveIdentifier(
  name: string,
  unit: SourceUnit,
  context: ExtractionContext,
  seen = new Set<string>(),
): { node: ts.Node; unit: SourceUnit } | null {
  const key = `${unit.file}:${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const hint = RESOLVED_IDENTIFIER_HINTS.get(key);
  if (hint) {
    const hintedUnit = unitFor(hint.file, context.units);
    const hintedNode = hintedUnit.declarations.get(hint.declarationName);
    if (hintedNode) return { node: hintedNode, unit: hintedUnit };
    RESOLVED_IDENTIFIER_HINTS.delete(key);
  }
  const remember = (
    result: { node: ts.Node; unit: SourceUnit } | null,
  ): { node: ts.Node; unit: SourceUnit } | null => {
    if (!result) return null;
    const declarationName =
      (ts.isVariableDeclaration(result.node) &&
      ts.isIdentifier(result.node.name)
        ? result.node.name.text
        : (ts.isFunctionDeclaration(result.node) ||
              ts.isClassDeclaration(result.node) ||
              ts.isEnumDeclaration(result.node)) &&
            result.node.name
          ? result.node.name.text
          : null) ?? null;
    if (declarationName) {
      RESOLVED_IDENTIFIER_HINTS.set(key, {
        file: result.unit.file,
        declarationName,
      });
    }
    return result;
  };
  const local = unit.declarations.get(name);
  if (local) return remember({ node: local, unit });
  const imported = unit.imports.get(name);
  if (!imported) {
    for (const statement of unit.ast.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier)
        continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const exportedFile = resolveModule(
        unit.file,
        statement.moduleSpecifier.text,
      );
      if (!exportedFile) continue;
      const exportedUnit = unitFor(exportedFile, context.units);
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const element = statement.exportClause.elements.find(
          (entry) => entry.name.text === name,
        );
        if (!element) continue;
        const resolved = resolveIdentifier(
          element.propertyName?.text ?? element.name.text,
          exportedUnit,
          context,
          seen,
        );
        if (resolved) return remember(resolved);
      } else if (!statement.exportClause) {
        const resolved = resolveIdentifier(name, exportedUnit, context, seen);
        if (resolved) return remember(resolved);
      }
    }
    return null;
  }
  const target = unitFor(imported.file, context.units);
  if (imported.imported === "default") {
    for (const statement of target.ast.statements) {
      if (ts.isExportAssignment(statement))
        return { node: statement.expression, unit: target };
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const element = statement.exportClause.elements.find(
          (entry) => entry.name.text === "default",
        );
        if (element) {
          const declaration = target.declarations.get(
            element.propertyName?.text ?? element.name.text,
          );
          if (declaration) return { node: declaration, unit: target };
        }
      }
    }
  }
  return remember(resolveIdentifier(imported.imported, target, context, seen));
}

function resolveWorkspaceImportedIdentifier(
  name: string,
  unit: SourceUnit,
  context: ExtractionContext,
): { node: ts.Node; unit: SourceUnit } | null {
  for (const statement of unit.ast.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find((entry) => entry.name.text === name);
    if (!element) continue;
    const specifier = statement.moduleSpecifier.text;
    const targetFile = resolveWorkspaceModule(specifier);
    if (!targetFile) return null;
    const target = unitFor(targetFile, context.units);
    const importedName = element.propertyName?.text ?? element.name.text;
    const exported = resolveIdentifier(importedName, target, context);
    if (exported) return exported;
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    const packageDir = WORKSPACE_PACKAGE_DIRS_BY_NAME?.get(packageName);
    if (!packageDir) return null;
    const cacheKey = `${packageDir}:${importedName}`;
    const cached = RESOLVED_WORKSPACE_SYMBOLS.get(cacheKey);
    if (cached === null) return null;
    if (cached) {
      const cachedUnit = unitFor(cached.file, context.units);
      const cachedNode = cachedUnit.declarations.get(cached.declarationName);
      return cachedNode ? { node: cachedNode, unit: cachedUnit } : null;
    }
    const matches = reachableProductionFiles(packageDir).flatMap((file) => {
      const candidateUnit = unitFor(file, context.units);
      const declaration = candidateUnit.declarations.get(importedName);
      return declaration ? [{ node: declaration, unit: candidateUnit }] : [];
    });
    if (matches.length !== 1) {
      RESOLVED_WORKSPACE_SYMBOLS.set(cacheKey, null);
      return null;
    }
    RESOLVED_WORKSPACE_SYMBOLS.set(cacheKey, {
      file: matches[0].unit.file,
      declarationName: importedName,
    });
    return matches[0];
  }
  return null;
}

function nearestLocalDeclaration(
  name: string,
  before: ts.Node,
  unit: SourceUnit,
): ts.Node | null {
  let nearest: ts.Node | null = null;
  const visit = (candidate: ts.Node): void => {
    if (candidate.pos >= before.pos) return;
    if (
      ((ts.isVariableDeclaration(candidate) ||
        ts.isParameter(candidate) ||
        ts.isFunctionDeclaration(candidate)) &&
        candidate.name &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === name) ||
      (ts.isClassDeclaration(candidate) && candidate.name?.text === name)
    ) {
      if (!nearest || candidate.pos > nearest.pos) nearest = candidate;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(unit.ast);
  return nearest;
}

function nodeInitializer(node: ts.Node): ts.Node | null {
  if (ts.isVariableDeclaration(node)) return node.initializer ?? null;
  if (ts.isPropertyAssignment(node)) return node.initializer;
  if (ts.isExportAssignment(node)) return node.expression;
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  ) {
    if (!node.body) return null;
    if (ts.isBlock(node.body)) {
      const returned = node.body.statements.find(ts.isReturnStatement);
      return returned?.expression ?? null;
    }
    return node.body;
  }
  return node;
}

function resolvedScalar(
  node: ts.Node,
  unit: SourceUnit,
  context: ExtractionContext,
): string | null {
  const current = unwrap(nodeInitializer(node) ?? node);
  const literal = literalText(current);
  if (literal !== null) return literal;
  if (ts.isIdentifier(current)) {
    const resolved =
      resolveIdentifier(current.text, unit, context) ??
      resolveWorkspaceImportedIdentifier(current.text, unit, context);
    return resolved
      ? resolvedScalar(resolved.node, resolved.unit, context)
      : null;
  }
  if (ts.isPropertyAccessExpression(current)) {
    if (ts.isIdentifier(current.expression)) {
      const resolved =
        resolveIdentifier(current.expression.text, unit, context) ??
        resolveWorkspaceImportedIdentifier(
          current.expression.text,
          unit,
          context,
        );
      if (resolved) {
        const owner = unwrap(nodeInitializer(resolved.node) ?? resolved.node);
        if (ts.isObjectLiteralExpression(owner)) {
          const property = owner.properties.find(
            (candidate): candidate is ts.PropertyAssignment =>
              ts.isPropertyAssignment(candidate) &&
              propertyName(candidate.name) === current.name.text,
          );
          if (property) {
            return resolvedScalar(property.initializer, resolved.unit, context);
          }
        } else if (ts.isEnumDeclaration(owner)) {
          const member = owner.members.find(
            (candidate) => propertyName(candidate.name) === current.name.text,
          );
          if (member?.initializer) {
            return resolvedScalar(member.initializer, resolved.unit, context);
          }
        }
      }
      if (current.expression.text === "EventType") return current.name.text;
    }
    return null;
  }
  return null;
}

function nameFromObject(
  object: ts.ObjectLiteralExpression,
  kind: RuntimeSurfaceKind,
  unit: SourceUnit,
  context: ExtractionContext,
): string | null {
  for (const key of NAME_KEYS[kind]) {
    const property = object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        propertyName(candidate.name) === key,
    );
    if (!property) continue;
    const value = resolvedScalar(property.initializer, unit, context);
    if (value) return value;
  }
  return null;
}

function surfaceNameFromObject(
  object: ts.ObjectLiteralExpression,
  kind: RuntimeSurfaceKind,
  unit: SourceUnit,
  context: ExtractionContext,
): string | null {
  const name = nameFromObject(object, kind, unit, context);
  if (kind !== "route" || !name) return name;
  const typeProperty = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === "type",
  );
  const method = typeProperty
    ? resolvedScalar(typeProperty.initializer, unit, context)?.toUpperCase()
    : null;
  return method && MOCKOON_HTTP_METHODS.has(method)
    ? `${method} ${name}`
    : null;
}

function staticClassServiceType(
  node: ts.ClassDeclaration,
  unit: SourceUnit,
  context: ExtractionContext,
): string | null {
  for (const member of node.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      propertyName(member.name) !== "serviceType"
    )
      continue;
    if (
      !member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
      )
    )
      continue;
    if (member.initializer)
      return resolvedScalar(member.initializer, unit, context);
  }
  return null;
}

function expressionIdentity(node: ts.Node, unit: SourceUnit): string {
  const text = node.getText(unit.ast).replace(/\s+/g, " ").trim();
  return normalizeName(text.slice(0, 180));
}

function extractExplicitSubactions(
  object: ts.ObjectLiteralExpression,
  unit: SourceUnit,
  context: ExtractionContext,
): string[] {
  const names = new Set<string>();
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === "subActions",
  );
  if (!property) return [];
  const current = unwrap(property.initializer);
  if (ts.isArrayLiteralExpression(current)) {
    for (const element of current.elements) {
      const scalar = resolvedScalar(element, unit, context);
      if (scalar) names.add(scalar);
      else {
        const resolved = resolveObject(element, unit, context);
        const name = resolved
          ? nameFromObject(resolved.object, "action", resolved.unit, context)
          : null;
        if (name) names.add(name);
      }
    }
  }
  return [...names].sort();
}

function directParameterSubactions(
  object: ts.ObjectLiteralExpression,
): string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const nameProperty = node.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name) === "name",
      );
      const parameterName = nameProperty
        ? literalText(unwrap(nameProperty.initializer))
        : null;
      if (
        parameterName &&
        ["action", "subaction", "op", "operation", "verb"].includes(
          parameterName,
        )
      ) {
        const collectEnums = (candidate: ts.Node): void => {
          if (
            ts.isPropertyAssignment(candidate) &&
            propertyName(candidate.name) === "enum" &&
            ts.isArrayLiteralExpression(unwrap(candidate.initializer))
          ) {
            for (const element of (
              unwrap(candidate.initializer) as ts.ArrayLiteralExpression
            ).elements) {
              const value = literalText(unwrap(element));
              if (value) names.add(value);
            }
          }
          ts.forEachChild(candidate, collectEnums);
        };
        collectEnums(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(object);
  return [...names].sort();
}

function extractPromotedSubactions(
  object: ts.ObjectLiteralExpression,
  unit: SourceUnit,
  context: ExtractionContext,
): string[] {
  const parametersProperty = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      propertyName(candidate.name) === "parameters",
  );
  if (!parametersProperty) return [];
  const parameterEntries = extractEntries(
    parametersProperty.initializer,
    unit,
    "subaction",
    context,
  );
  const names = new Set<string>();
  for (const entry of parameterEntries) {
    if (!entry.object) continue;
    const parameterName = nameFromObject(
      entry.object,
      "subaction",
      unit,
      context,
    );
    if (
      !parameterName ||
      !["action", "subaction", "op", "operation", "verb"].includes(
        parameterName,
      )
    ) {
      continue;
    }
    const schema = entry.object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        propertyName(candidate.name) === "schema",
    );
    if (!schema) continue;
    const schemaObject = resolveObject(schema.initializer, unit, context);
    if (!schemaObject) continue;
    const enumProperty = schemaObject.object.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        propertyName(candidate.name) === "enum",
    );
    if (!enumProperty) continue;
    const enumEntries = extractEntries(
      enumProperty.initializer,
      schemaObject.unit,
      "subaction",
      context,
    );
    for (const enumEntry of enumEntries) names.add(enumEntry.name);
  }
  return [...names].sort();
}

function promotedSubactionsIn(
  node: ts.Node,
  unit: SourceUnit,
  context: ExtractionContext,
): Array<{ name: string; sourceFile: string }> {
  const rows: Array<{ name: string; sourceFile: string }> = [];
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isCallExpression(candidate) &&
      expressionIdentity(candidate.expression, unit).endsWith(
        "promoteSubactionsToActions",
      ) &&
      candidate.arguments[0]
    ) {
      const resolved = resolveObject(candidate.arguments[0], unit, context);
      const parent = resolved
        ? (nameFromObject(resolved.object, "action", resolved.unit, context) ??
          expressionIdentity(candidate.arguments[0], unit))
        : expressionIdentity(candidate.arguments[0], unit);
      if (resolved) {
        for (const subaction of extractPromotedSubactions(
          resolved.object,
          resolved.unit,
          context,
        )) {
          rows.push({
            name: `${parent}_${subaction}`,
            sourceFile: resolved.unit.file,
          });
        }
      }
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return rows;
}

function resolveObject(
  node: ts.Node,
  unit: SourceUnit,
  context: ExtractionContext,
): { object: ts.ObjectLiteralExpression; unit: SourceUnit } | null {
  const current = unwrap(nodeInitializer(node) ?? node);
  if (ts.isObjectLiteralExpression(current)) return { object: current, unit };
  if (ts.isIdentifier(current)) {
    const resolved = resolveIdentifier(current.text, unit, context);
    return resolved
      ? resolveObject(resolved.node, resolved.unit, context)
      : null;
  }
  if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
    const resolved = resolveIdentifier(current.expression.text, unit, context);
    return resolved
      ? resolveObject(resolved.node, resolved.unit, context)
      : null;
  }
  return null;
}

function modelFactoryEntries(
  call: ts.CallExpression,
  unit: SourceUnit,
  context: ExtractionContext,
): Array<{ name: string; sourceFile: string }> {
  if (!ts.isIdentifier(call.expression)) return [];
  const resolved = resolveIdentifier(call.expression.text, unit, context);
  if (
    !resolved ||
    (!ts.isFunctionDeclaration(resolved.node) &&
      !ts.isFunctionExpression(resolved.node) &&
      !ts.isArrowFunction(resolved.node)) ||
    !resolved.node.body
  )
    return [];
  const names = new Set<string>();
  const collect = (
    candidate: ts.Node,
    sourceUnit: SourceUnit,
    seen = new Set<string>(),
  ): void => {
    const key = `${sourceUnit.file}:${candidate.pos}:${candidate.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const current = unwrap(nodeInitializer(candidate) ?? candidate);
    if (ts.isPropertyAccessExpression(current)) {
      if (current.expression.getText(sourceUnit.ast).endsWith("ModelType"))
        names.add(current.name.text);
      return;
    }
    if (ts.isIdentifier(current)) {
      const local = nearestLocalDeclaration(current.text, current, sourceUnit);
      const declaration = local
        ? { node: local, unit: sourceUnit }
        : resolveIdentifier(current.text, sourceUnit, context);
      if (declaration) collect(declaration.node, declaration.unit, seen);
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements)
        collect(
          ts.isSpreadElement(element) ? element.expression : element,
          sourceUnit,
          seen,
        );
      return;
    }
    if (ts.isConditionalExpression(current)) {
      collect(current.whenTrue, sourceUnit, seen);
      collect(current.whenFalse, sourceUnit, seen);
    }
  };
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isForOfStatement(candidate) &&
      /\bmodels\s*\[/.test(candidate.statement.getText(resolved.unit.ast))
    ) {
      collect(candidate.expression, resolved.unit);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(resolved.node.body);
  return [...names]
    .sort()
    .map((name) => ({ name, sourceFile: resolved.unit.file }));
}

function modelNamesFromEnclosingLoop(
  argument: ts.Node,
  unit: SourceUnit,
  context: ExtractionContext,
): string[] {
  if (!ts.isIdentifier(unwrap(argument))) return [];
  const argumentName = (unwrap(argument) as ts.Identifier).text;
  let parent: ts.Node | undefined = argument.parent;
  while (parent) {
    if (ts.isForOfStatement(parent)) {
      if (!ts.isVariableDeclarationList(parent.initializer)) {
        parent = parent.parent;
        continue;
      }
      const declaration = parent.initializer.declarations[0];
      if (
        declaration &&
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === argumentName
      ) {
        const names = new Set<string>();
        const collect = (
          candidate: ts.Node,
          seen = new Set<string>(),
        ): void => {
          const key = `${unit.file}:${candidate.pos}:${candidate.end}`;
          if (seen.has(key)) return;
          seen.add(key);
          const current = unwrap(nodeInitializer(candidate) ?? candidate);
          if (
            ts.isPropertyAccessExpression(current) &&
            current.expression.getText(unit.ast).endsWith("ModelType")
          ) {
            names.add(current.name.text);
          } else if (ts.isIdentifier(current)) {
            const resolved = resolveIdentifier(current.text, unit, {
              units: context.units,
              seen: new Set(),
            });
            if (resolved) collect(resolved.node, seen);
          } else if (ts.isArrayLiteralExpression(current)) {
            for (const element of current.elements)
              collect(
                ts.isSpreadElement(element) ? element.expression : element,
                seen,
              );
          }
        };
        collect(parent.expression);
        return [...names].sort();
      }
    }
    parent = parent.parent;
  }
  return [];
}

function directModelRegistrationNames(ast: ts.SourceFile): string[] {
  const declarations = new Map<string, ts.Expression>();
  const names = new Set<string>();
  const collectExpression = (node: ts.Node): void => {
    const current = unwrap(node);
    if (
      ts.isPropertyAccessExpression(current) &&
      current.expression.getText(ast).endsWith("ModelType")
    ) {
      names.add(current.name.text);
    } else if (ts.isIdentifier(current)) {
      const initializer = declarations.get(current.text);
      if (initializer) collectExpression(initializer);
    } else if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements)
        collectExpression(
          ts.isSpreadElement(element) ? element.expression : element,
        );
    }
  };
  const index = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    )
      declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, index);
  };
  index(ast);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "registerModel" &&
      node.arguments[0]
    ) {
      const argument = unwrap(node.arguments[0]);
      collectExpression(argument);
      if (ts.isIdentifier(argument)) {
        let parent: ts.Node | undefined = node.parent;
        while (parent) {
          if (ts.isForOfStatement(parent)) {
            if (!ts.isVariableDeclarationList(parent.initializer)) break;
            const declaration = parent.initializer.declarations[0];
            if (
              declaration &&
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === argument.text
            ) {
              collectExpression(parent.expression);
              if (ts.isIdentifier(parent.expression)) {
                const arrayName = parent.expression.text;
                const collectPushes = (candidate: ts.Node): void => {
                  if (
                    ts.isCallExpression(candidate) &&
                    ts.isPropertyAccessExpression(candidate.expression) &&
                    ts.isIdentifier(candidate.expression.expression) &&
                    candidate.expression.expression.text === arrayName &&
                    candidate.expression.name.text === "push"
                  ) {
                    for (const pushed of candidate.arguments)
                      collectExpression(pushed);
                  }
                  ts.forEachChild(candidate, collectPushes);
                };
                collectPushes(ast);
              }
            }
            break;
          }
          parent = parent.parent;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...names].sort();
}

function extractEntries(
  node: ts.Node,
  unit: SourceUnit,
  kind: RuntimeSurfaceKind,
  context: ExtractionContext,
): Array<{
  name: string;
  sourceFile: string;
  object?: ts.ObjectLiteralExpression;
}> {
  const key = `${unit.file}:${node.pos}:${node.end}:${kind}`;
  if (context.seen.has(key)) return [];
  context.seen.add(key);
  const current = unwrap(nodeInitializer(node) ?? node);
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.flatMap((element) => {
      if (ts.isSpreadElement(element))
        return extractEntries(element.expression, unit, kind, context);
      return extractEntries(element, unit, kind, context);
    });
  }
  if (ts.isObjectLiteralExpression(current)) {
    if (kind === "event-handler" || kind === "model-handler") {
      const directName = nameFromObject(current, kind, unit, context);
      if (!directName) {
        return current.properties.flatMap((property) => {
          if (ts.isSpreadAssignment(property))
            return extractEntries(property.expression, unit, kind, context);
          const name = resolvedPropertyName(property.name, unit, context);
          return name ? [{ name, sourceFile: unit.file, object: current }] : [];
        });
      }
    }
    return [
      {
        name: surfaceNameFromObject(current, kind, unit, context) ?? "",
        sourceFile: unit.file,
        object: current,
      },
    ];
  }
  if (ts.isIdentifier(current)) {
    const resolved = resolveIdentifier(current.text, unit, context);
    if (resolved) {
      const resolvedNode = nodeInitializer(resolved.node) ?? resolved.node;
      if (ts.isClassDeclaration(resolved.node) && kind === "service") {
        return [
          {
            name:
              staticClassServiceType(resolved.node, resolved.unit, context) ??
              current.text,
            sourceFile: resolved.unit.file,
          },
        ];
      }
      const nested = extractEntries(resolvedNode, resolved.unit, kind, context);
      if (nested.length > 0) return nested;
    }
    return [];
  }
  if (ts.isCallExpression(current)) {
    const callee = expressionIdentity(current.expression, unit);
    if (kind === "model-handler") {
      const modelEntries = modelFactoryEntries(current, unit, context);
      if (modelEntries.length > 0) return modelEntries;
    }
    if (
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "map"
    ) {
      const mappedExpression = current.expression.expression;
      const sourceEntries = extractEntries(
        mappedExpression,
        unit,
        kind,
        context,
      );
      if (
        sourceEntries.length > 0 &&
        !sourceEntries.every(
          (entry) => entry.name === expressionIdentity(mappedExpression, unit),
        )
      ) {
        return sourceEntries;
      }
      return [];
    }
    if (callee.endsWith("promoteSubactionsToActions") && current.arguments[0]) {
      const parentEntries = extractEntries(
        current.arguments[0],
        unit,
        "action",
        context,
      );
      return parentEntries;
    }
    const resolved = ts.isIdentifier(current.expression)
      ? resolveIdentifier(current.expression.text, unit, context)
      : null;
    if (resolved) {
      const nested = extractEntries(
        resolved.node,
        resolved.unit,
        kind,
        context,
      );
      if (nested.length > 0) return nested;
    }
    return [];
  }
  if (ts.isPropertyAccessExpression(current)) {
    return [{ name: current.name.text, sourceFile: unit.file }];
  }
  return [];
}

function pluginObjects(
  unit: SourceUnit,
): Array<{ object: ts.ObjectLiteralExpression; unit: SourceUnit }> {
  const roots: Array<{ object: ts.ObjectLiteralExpression; unit: SourceUnit }> =
    [];
  const visit = (node: ts.Node): void => {
    if (
      pluginTyped(node) ||
      (ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        /plugin$/i.test(node.name.text) &&
        Boolean(node.initializer))
    ) {
      const resolved = resolveObject(node, unit, {
        units: new Map([[unit.file, unit]]),
        seen: new Set(),
      });
      if (resolved) roots.push(resolved);
    }
    ts.forEachChild(node, visit);
  };
  visit(unit.ast);
  return roots;
}

function extractPluginSurfaces(
  packageDir: string,
  packageInfo: PackageContext,
): RawSurface[] {
  const files = reachableProductionFiles(packageDir);
  const units = new Map<string, SourceUnit>();
  for (const file of files) {
    // Only files that can contain a typed Plugin root enter the first pass;
    // imports and spreads are resolved lazily from that authoritative root.
    if (/\bPlugin\b/.test(readFileSync(file, "utf8"))) unitFor(file, units);
  }
  const context: ExtractionContext = { units, seen: new Set() };
  const raw: RawSurface[] = [];
  const rootKeys = new Set<string>();
  for (const unit of units.values()) {
    for (const root of pluginObjects(unit)) {
      const rootKey = `${root.unit.file}:${root.object.pos}:${root.object.end}`;
      if (rootKeys.has(rootKey)) continue;
      rootKeys.add(rootKey);
      for (const property of root.object.properties) {
        if (ts.isSpreadAssignment(property)) {
          const resolved = resolveObject(
            property.expression,
            root.unit,
            context,
          );
          if (resolved) {
            for (const nested of resolved.object.properties) {
              if (!ts.isPropertyAssignment(nested)) continue;
              const field = propertyName(nested.name);
              const kind = field ? PLUGIN_FIELDS.get(field) : undefined;
              if (!field || !kind) continue;
              for (const entry of extractEntries(
                nested.initializer,
                resolved.unit,
                kind,
                context,
              )) {
                raw.push({
                  kind,
                  name: entry.name,
                  sourcePath: toRepoPath(entry.sourceFile),
                  registrationField: field,
                  package: packageInfo,
                });
              }
            }
          }
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        const field = propertyName(property.name);
        const kind = field ? PLUGIN_FIELDS.get(field) : undefined;
        if (!field || !kind) continue;
        for (const entry of extractEntries(
          property.initializer,
          root.unit,
          kind,
          context,
        )) {
          raw.push({
            kind,
            name: entry.name,
            sourcePath: toRepoPath(entry.sourceFile),
            registrationField: field,
            package: packageInfo,
          });
          if (kind === "action" && entry.object) {
            const entryUnit = unitFor(entry.sourceFile, context.units);
            const explicit = extractExplicitSubactions(
              entry.object,
              entryUnit,
              { units: context.units, seen: new Set() },
            );
            const parameterEnums = extractPromotedSubactions(
              entry.object,
              entryUnit,
              { units: context.units, seen: new Set() },
            );
            parameterEnums.push(...directParameterSubactions(entry.object));
            const promoted = parameterEnums.map(
              (name) => `${entry.name}_${name}`,
            );
            for (const subaction of [...new Set([...explicit, ...promoted])]) {
              raw.push({
                kind: "subaction",
                name: subaction,
                sourcePath: toRepoPath(entry.sourceFile),
                registrationField: "actions[].parameters[].schema.enum",
                package: packageInfo,
              });
            }
          }
        }
        if (kind === "action") {
          for (const entry of promotedSubactionsIn(
            property.initializer,
            root.unit,
            context,
          )) {
            raw.push({
              kind: "subaction",
              name: entry.name,
              sourcePath: toRepoPath(entry.sourceFile),
              registrationField: "promoteSubactionsToActions",
              package: packageInfo,
            });
          }
        }
      }
    }
  }
  return raw;
}

export function collectCallRegisteredSurfaces(
  packageDir: string,
  packageInfo: PackageContext,
): RawSurface[] {
  const result: RawSurface[] = [];
  const files = reachableProductionFiles(packageDir);
  for (const file of files) {
    const units = new Map<string, SourceUnit>();
    const unit = unitFor(file, units);
    const { source, ast } = unit;
    const context: ExtractionContext = { units, seen: new Set() };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(ast);
        const reflectiveTarget =
          callee === "Reflect.apply" &&
          node.arguments[0] &&
          ts.isPropertyAccessExpression(unwrap(node.arguments[0]))
            ? (unwrap(node.arguments[0]) as ts.PropertyAccessExpression)
            : null;
        if (
          reflectiveTarget?.name.text === "registerService" &&
          node.arguments[2] &&
          ts.isArrayLiteralExpression(unwrap(node.arguments[2]))
        ) {
          const serviceArguments = unwrap(
            node.arguments[2],
          ) as ts.ArrayLiteralExpression;
          for (const serviceArgument of serviceArguments.elements) {
            for (const entry of extractEntries(
              serviceArgument,
              unit,
              "service",
              context,
            )) {
              result.push({
                kind: "service",
                name: entry.name,
                sourcePath: toRepoPath(entry.sourceFile),
                registrationField: "Reflect.apply(runtime.registerService)",
                package: packageInfo,
              });
            }
          }
          ts.forEachChild(node, visit);
          return;
        }
        const calleeName = reflectiveTarget
          ? reflectiveTarget.name.text
          : ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : null;
        let kind: RuntimeSurfaceKind | null = null;
        const isMethodCall =
          reflectiveTarget !== null ||
          ts.isPropertyAccessExpression(node.expression);
        const receiver = reflectiveTarget
          ? reflectiveTarget.expression.getText(ast)
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.expression.getText(ast)
            : "";
        const isRuntimeCall =
          isMethodCall && /(?:runtime|withRegistry)/i.test(receiver);
        if (
          isRuntimeCall &&
          calleeName !== null &&
          /^(?:registerConnector|registerMessageConnector|registerIngress|registerWebhook)$/.test(
            calleeName,
          )
        ) {
          kind = "connector-ingress";
        } else if (
          isRuntimeCall &&
          calleeName !== null &&
          /^(?:registerSendHandler|registerDelivery|registerEgress)$/.test(
            calleeName,
          )
        ) {
          kind = "connector-egress";
        } else if (isRuntimeCall && calleeName === "registerPostConnector") {
          kind = "connector-ingress";
        } else if (isRuntimeCall && calleeName === "registerAction") {
          kind = "action";
        } else if (isRuntimeCall && calleeName === "registerProvider") {
          kind = "provider";
        } else if (isRuntimeCall && calleeName === "registerService") {
          kind = "service";
        } else if (
          isMethodCall &&
          calleeName === "registerDatabaseAdapter" &&
          /(?:runtime|\br\b)/i.test(receiver)
        ) {
          kind = "service";
        } else if (isRuntimeCall && calleeName === "registerEvaluator") {
          kind = "evaluator";
        } else if (
          isRuntimeCall &&
          calleeName === "registerResponseHandlerEvaluator"
        ) {
          kind = "response-handler-evaluator";
        } else if (
          isRuntimeCall &&
          calleeName === "registerResponseHandlerFieldEvaluator"
        ) {
          kind = "response-handler-field-evaluator";
        } else if (isRuntimeCall && calleeName === "registerModel") {
          kind = "model-handler";
        } else if (isRuntimeCall && calleeName === "registerEvent") {
          kind = "event-handler";
        } else if (calleeName === "registerOverlayApp") {
          kind = "view";
        } else if (
          calleeName !== null &&
          (/^registerNativePlugin$/i.test(calleeName) ||
            (/^registerPlugin$/i.test(calleeName) &&
              /from\s+["']@capacitor\/core["']/.test(source)))
        ) {
          kind = "native-bridge";
        } else if (
          isRuntimeCall &&
          calleeName !== null &&
          /^(?:register(?:Scheduled|Task|Cron).*Worker|registerWorker)$/i.test(
            calleeName,
          )
        ) {
          kind = "scheduled-worker";
        } else if (
          calleeName !== null &&
          /^(?:registerQueue|consumer|producer)$/i.test(calleeName) &&
          (/queue/i.test(calleeName) ||
            (isMethodCall && /queue/i.test(receiver)))
        ) {
          kind = "queue";
        }
        if (kind === "scheduled-worker") {
          let ancestor: ts.Node | undefined = node.parent;
          while (ancestor) {
            if (
              ts.isMethodDeclaration(ancestor) &&
              propertyName(ancestor.name) === "createTestTasks"
            ) {
              kind = null;
              break;
            }
            ancestor = ancestor.parent;
          }
        }
        if (kind) {
          const reflectiveArguments = node.arguments[2]
            ? unwrap(node.arguments[2])
            : null;
          const firstArgument =
            reflectiveTarget &&
            reflectiveArguments &&
            ts.isArrayLiteralExpression(reflectiveArguments)
              ? reflectiveArguments.elements[0]
              : node.arguments[0];
          const localArgument =
            firstArgument && ts.isIdentifier(unwrap(firstArgument))
              ? (nearestLocalDeclaration(
                  (unwrap(firstArgument) as ts.Identifier).text,
                  node,
                  unit,
                ) ?? firstArgument)
              : firstArgument;
          const registeredObject = localArgument
            ? resolveObject(localArgument, unit, context)
            : null;
          const unresolvedDynamicProperty = Boolean(
            localArgument &&
              ts.isPropertyAccessExpression(unwrap(localArgument)) &&
              !registeredObject,
          );
          const registeredServiceType = (() => {
            if (kind !== "service" || !localArgument) return null;
            const current = unwrap(localArgument);
            const classIdentifier = ts.isIdentifier(current)
              ? current
              : ts.isNewExpression(current) &&
                  ts.isIdentifier(current.expression)
                ? current.expression
                : null;
            if (!classIdentifier) return null;
            const resolved = resolveIdentifier(
              classIdentifier.text,
              unit,
              context,
            );
            return resolved && ts.isClassDeclaration(resolved.node)
              ? staticClassServiceType(resolved.node, resolved.unit, context)
              : null;
          })();
          const registeredName =
            calleeName === "registerDatabaseAdapter"
              ? "database-adapter"
              : registeredServiceType
                ? registeredServiceType
                : unresolvedDynamicProperty
                  ? null
                  : registeredObject
                    ? nameFromObject(
                        registeredObject.object,
                        kind,
                        registeredObject.unit,
                        context,
                      )
                    : localArgument
                      ? resolvedScalar(localArgument, unit, context)
                      : null;
          const registeredNames = registeredName
            ? [registeredName]
            : kind === "model-handler" && firstArgument
              ? modelNamesFromEnclosingLoop(firstArgument, unit, context)
              : [];
          for (const name of registeredNames) {
            result.push({
              kind,
              name,
              sourcePath: toRepoPath(file),
              registrationField: callee,
              package: packageInfo,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const name of directModelRegistrationNames(ast)) {
      result.push({
        kind: "model-handler",
        name,
        sourcePath: toRepoPath(file),
        registrationField: "runtime.registerModel",
        package: packageInfo,
      });
    }
  }
  return result;
}

function workspacePackageDirs(): string[] {
  const pluginRoot = path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins");
  const dirs: string[] = [];
  for (const entry of readdirSync(pluginRoot).sort()) {
    const dir = path.join(pluginRoot, entry);
    if (
      entry.startsWith("plugin-") &&
      existsSync(path.join(dir, "package.json"))
    ) {
      dirs.push(dir);
    }
  }
  // These hosts contribute Plugin registrations directly. Cloud routes,
  // services and Worker bindings have their own production-config extractors
  // below so the inventory never parses the entire Cloud implementation tree.
  dirs.push(
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/core"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/agent"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/app-core"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/api"),
  );
  const cloudServicesRoot = path.join(
    RUNTIME_SURFACE_REPO_ROOT,
    "packages/cloud/services",
  );
  for (const entry of readdirSync(cloudServicesRoot).sort()) {
    const dir = path.join(cloudServicesRoot, entry);
    if (
      !entry.startsWith("_") &&
      statSync(dir).isDirectory() &&
      existsSync(path.join(dir, "package.json"))
    ) {
      dirs.push(dir);
    }
  }
  return [...new Set(dirs)].sort();
}

function hostAssemblySurfaces(): RawSurface[] {
  const hostFiles = [
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/core"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/agent"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/app-core"),
  ].flatMap(reachableProductionFiles);
  const hostSources = hostFiles.map((file) => {
    const source = readFileSync(file, "utf8");
    return {
      file,
      source,
      ast: ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    };
  });
  const hostUseCache = new Map<string, Set<string>>();
  const hostUsedExports = (
    host: (typeof hostSources)[number],
    packageName: string,
  ): Set<string> => {
    const cacheKey = `${host.file}:${packageName}`;
    const cached = hostUseCache.get(cacheKey);
    if (cached) return cached;
    const localExports = new Map<string, string>();
    const namespaces = new Set<string>();
    const ownsSpecifier = (specifier: string): boolean =>
      specifier === packageName || specifier.startsWith(`${packageName}/`);
    const importCall = (
      node: ts.Node | undefined,
    ): ts.CallExpression | null => {
      if (!node) return null;
      let current = unwrap(node);
      if (ts.isAwaitExpression(current)) current = unwrap(current.expression);
      return ts.isCallExpression(current) &&
        current.expression.kind === ts.SyntaxKind.ImportKeyword &&
        current.arguments[0] &&
        ts.isStringLiteral(current.arguments[0]) &&
        ownsSpecifier(current.arguments[0].text)
        ? current
        : null;
    };
    for (const statement of host.ast.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        ownsSpecifier(statement.moduleSpecifier.text) &&
        statement.importClause
      ) {
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            localExports.set(
              element.name.text,
              element.propertyName?.text ?? element.name.text,
            );
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          namespaces.add(bindings.name.text);
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!importCall(declaration.initializer)) continue;
          if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (!element.dotDotDotToken && ts.isIdentifier(element.name)) {
                localExports.set(
                  element.name.text,
                  element.propertyName?.getText(host.ast) ?? element.name.text,
                );
              }
            }
          } else if (ts.isIdentifier(declaration.name)) {
            namespaces.add(declaration.name.text);
          }
        }
      }
    }
    const loaderFunctions = new Set<string>();
    const containsPackageImport = (node: ts.Node): boolean => {
      let found = false;
      const inspect = (candidate: ts.Node): void => {
        if (found) return;
        if (importCall(candidate)) {
          found = true;
          return;
        }
        ts.forEachChild(candidate, inspect);
      };
      inspect(node);
      return found;
    };
    const indexLoaders = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.body &&
        containsPackageImport(node.body)
      ) {
        loaderFunctions.add(node.name.text);
      }
      ts.forEachChild(node, indexLoaders);
    };
    indexLoaders(host.ast);
    const containsLoaderCall = (node: ts.Node | undefined): boolean => {
      if (!node) return false;
      let found = false;
      const inspect = (candidate: ts.Node): void => {
        if (found) return;
        if (
          ts.isCallExpression(candidate) &&
          ts.isIdentifier(candidate.expression) &&
          loaderFunctions.has(candidate.expression.text)
        ) {
          found = true;
          return;
        }
        ts.forEachChild(candidate, inspect);
      };
      inspect(node);
      return found;
    };
    const indexDynamicImports = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        (importCall(node.initializer) || containsLoaderCall(node.initializer))
      ) {
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!element.dotDotDotToken && ts.isIdentifier(element.name)) {
              localExports.set(
                element.name.text,
                element.propertyName?.getText(host.ast) ?? element.name.text,
              );
            }
          }
        } else if (ts.isIdentifier(node.name)) {
          namespaces.add(node.name.text);
        }
      }
      ts.forEachChild(node, indexDynamicImports);
    };
    indexDynamicImports(host.ast);
    const used = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) {
          const imported = localExports.get(expression.text);
          if (imported) used.add(imported);
        }
        if (
          ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          namespaces.has(expression.expression.text)
        ) {
          used.add(expression.name.text);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          /^registerService$/.test(node.expression.name.text)
        ) {
          for (const argument of node.arguments) {
            const current = unwrap(argument);
            if (!ts.isIdentifier(current)) continue;
            const imported = localExports.get(current.text);
            if (imported) used.add(imported);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(host.ast);
    hostUseCache.set(cacheKey, used);
    return used;
  };
  const pluginRoot = path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins");
  const rows: RawSurface[] = [];
  for (const entry of readdirSync(pluginRoot).sort()) {
    const packageDir = path.join(pluginRoot, entry);
    const info = packageContext(packageDir);
    if (!info) continue;
    if (!hostSources.some((host) => host.source.includes(info.packageName)))
      continue;
    for (const entrypoint of packageEntryPoints(packageDir)) {
      const ast = ts.createSourceFile(
        entrypoint,
        readFileSync(entrypoint, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of ast.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause)
        )
          continue;
        for (const exported of statement.exportClause.elements) {
          if (exported.isTypeOnly) continue;
          const name = exported.name.text;
          const kind: RuntimeSurfaceKind | null = /^handle.*Routes$/.test(name)
            ? "route"
            : (/^[A-Z].*(?:Service|Manager)$/.test(name) &&
                  !/^I[A-Z]/.test(name)) ||
                (info.packageName === "@elizaos/plugin-registry" &&
                  /^(?:installPlugin|uninstallPlugin|listInstalledPlugins)$/.test(
                    name,
                  ))
              ? "service"
              : null;
          if (
            !kind ||
            !hostSources.some((host) =>
              hostUsedExports(host, info.packageName).has(name),
            )
          )
            continue;
          rows.push({
            kind,
            name,
            sourcePath: toRepoPath(entrypoint),
            registrationField: "production host import/call",
            package: info,
          });
        }
      }
    }
  }
  return rows;
}

export interface ServedCloudRoute {
  file: string;
  routePath: string;
}

function unwrapGeneratedRouterExpression(
  expression: ts.Expression,
): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Resolves canonical route records mounted by the generated production router. */
export function servedCloudRoutes(apiDir: string): ServedCloudRoute[] {
  const generatedRouter = path.join(apiDir, "src", "_router.generated.ts");
  if (!existsSync(generatedRouter)) return [];
  const ast = ts.createSourceFile(
    generatedRouter,
    readFileSync(generatedRouter, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let mounts: ts.ArrayLiteralExpression | null = null;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "ROUTE_MOUNTS" &&
        declaration.initializer
      ) {
        const initializer = unwrapGeneratedRouterExpression(
          declaration.initializer,
        );
        if (!ts.isArrayLiteralExpression(initializer)) {
          throw new Error(
            "Generated Cloud ROUTE_MOUNTS must be an array literal",
          );
        }
        mounts = initializer;
      }
    }
  }
  if (!mounts) {
    throw new Error("Generated Cloud router is missing ROUTE_MOUNTS");
  }
  const routes: ServedCloudRoute[] = [];
  for (const element of mounts.elements) {
    const unwrapped = unwrapGeneratedRouterExpression(element);
    if (!ts.isObjectLiteralExpression(unwrapped)) {
      throw new Error(
        "Generated Cloud ROUTE_MOUNTS contains a non-literal entry",
      );
    }
    let routePath: string | null = null;
    const moduleSpecifiers = new Set<string>();
    for (const property of unwrapped.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText(ast).replace(/["']/g, "");
      if (name === "path" && ts.isStringLiteral(property.initializer)) {
        routePath = property.initializer.text;
      }
      if (name === "load") {
        const findImport = (candidate: ts.Node): void => {
          if (
            ts.isCallExpression(candidate) &&
            candidate.expression.kind === ts.SyntaxKind.ImportKeyword &&
            candidate.arguments.length === 1 &&
            ts.isStringLiteral(candidate.arguments[0])
          ) {
            moduleSpecifiers.add(candidate.arguments[0].text);
          }
          ts.forEachChild(candidate, findImport);
        };
        findImport(property.initializer);
      }
    }
    if (!routePath?.startsWith("/") || moduleSpecifiers.size !== 1) {
      throw new Error(
        "Generated Cloud ROUTE_MOUNTS entry requires one canonical path and dynamic import",
      );
    }
    const moduleSpecifier = [...moduleSpecifiers][0];
    if (!moduleSpecifier) {
      throw new Error(
        "Generated Cloud ROUTE_MOUNTS entry has no dynamic import",
      );
    }
    const resolved = resolveModule(generatedRouter, moduleSpecifier);
    if (!resolved) {
      throw new Error(
        `Generated Cloud route import does not resolve: ${moduleSpecifier}`,
      );
    }
    routes.push({ file: resolved, routePath });
  }
  return routes.sort((a, b) =>
    `${a.routePath}:${a.file}`.localeCompare(`${b.routePath}:${b.file}`),
  );
}

/** Resolves only route modules mounted by the generated production router. */
export function servedCloudRouteFiles(apiDir: string): string[] {
  return [
    ...new Set(servedCloudRoutes(apiDir).map((route) => route.file)),
  ].sort();
}

function cloudRouteSurfaces(): RawSurface[] {
  const apiDir = path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/api");
  const info = packageContext(apiDir);
  if (!info) return [];
  const routes = servedCloudRoutes(apiDir);
  const rows: RawSurface[] = [];
  for (const { file, routePath } of routes) {
    const source = readFileSync(file, "utf8");
    const registrations = [
      ...source.matchAll(
        /\b(?:app|router|routes)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
      ),
    ].map((match) => ({ method: match[1].toUpperCase(), localPath: match[2] }));
    for (const match of source.matchAll(
      /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
    )) {
      registrations.push({ method: match[1], localPath: "/" });
    }
    if (registrations.length === 0 && /export\s+default\s+\w+/.test(source)) {
      registrations.push({ method: "ANY", localPath: "/" });
    }
    for (const registration of registrations) {
      const localPath =
        registration.localPath === "/" ? "" : registration.localPath;
      rows.push({
        kind: routePath.includes("/cron/") ? "scheduled-worker" : "route",
        name: `${registration.method} ${routePath}${localPath}`,
        sourcePath: toRepoPath(file),
        registrationField:
          registration.method === "ANY"
            ? "default Hono router export"
            : `Hono.${registration.method.toLowerCase()}`,
        package: info,
      });
    }
  }
  for (const file of [
    path.join(apiDir, "src", "bootstrap-app.ts"),
    path.join(apiDir, "src", "index.ts"),
  ]) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\b(?:app|router|routes)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    )) {
      rows.push({
        kind: "route",
        name: `${match[1].toUpperCase()} ${match[2]}`,
        sourcePath: toRepoPath(file),
        registrationField: `manual Hono.${match[1].toLowerCase()}`,
        package: info,
      });
    }
  }
  return rows;
}

function cloudServiceSurfaces(): RawSurface[] {
  const root = path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/services");
  const rows: RawSurface[] = [];
  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith("_")) continue;
    const dir = path.join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const info = packageContext(dir);
    if (!info) continue;
    const entrypoint = packageEntryPoints(dir)[0];
    if (!entrypoint) continue;
    rows.push({
      kind: "cloud-service",
      name: info.packageName,
      sourcePath: toRepoPath(entrypoint),
      registrationField: "package manifest or documented host boot entrypoint",
      package: info,
    });
  }
  return rows;
}

export function workerBindingsFromSource(
  file: string,
  source: string,
): Array<{ kind: "queue" | "scheduled-worker"; name: string }> {
  const rows: Array<{ kind: "queue" | "scheduled-worker"; name: string }> = [];
  if (/\.jsonc?$/.test(file)) {
    const parsed = ts.parseConfigFileTextToJson(file, source);
    if (parsed.error || !parsed.config || typeof parsed.config !== "object") {
      return rows;
    }
    const config = parsed.config as Record<string, unknown>;
    const queues = config.queues;
    if (queues && typeof queues === "object" && !Array.isArray(queues)) {
      for (const field of ["producers", "consumers"] as const) {
        const entries = (queues as Record<string, unknown>)[field];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            continue;
          const record = entry as Record<string, unknown>;
          const name =
            field === "producers" && typeof record.binding === "string"
              ? record.binding
              : typeof record.queue === "string"
                ? record.queue
                : typeof record.binding === "string"
                  ? record.binding
                  : null;
          if (name) rows.push({ kind: "queue", name });
        }
      }
    }
    const triggers = config.triggers;
    if (triggers && typeof triggers === "object" && !Array.isArray(triggers)) {
      const crons = (triggers as Record<string, unknown>).crons;
      if (Array.isArray(crons)) {
        for (const cron of crons) {
          if (typeof cron === "string")
            rows.push({ kind: "scheduled-worker", name: cron });
        }
      }
    }
    return rows;
  }
  for (const block of source.split(/^\s*\[\[/m)) {
    if (!/^queues\.(?:producers|consumers)\]\]/.test(block)) continue;
    const producer = /^queues\.producers\]\]/.test(block);
    const queue = producer
      ? (block.match(/^\s*binding\s*=\s*["']([^"']+)["']/m) ??
        block.match(/^\s*queue\s*=\s*["']([^"']+)["']/m))
      : (block.match(/^\s*queue\s*=\s*["']([^"']+)["']/m) ??
        block.match(/^\s*binding\s*=\s*["']([^"']+)["']/m));
    if (queue) rows.push({ kind: "queue", name: queue[1] });
  }
  const triggerSection = source.match(
    /^\s*\[triggers\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m,
  )?.[1];
  if (triggerSection) {
    const crons = triggerSection.match(/\bcrons?\s*=\s*\[([\s\S]*?)\]/)?.[1];
    if (crons) {
      for (const cron of crons.matchAll(/["']([^"']+)["']/g)) {
        rows.push({ kind: "scheduled-worker", name: cron[1] });
      }
    }
  }
  return rows;
}

function workerBindingSurfaces(): RawSurface[] {
  const files = walkFiles(
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud"),
    (file) => /^wrangler\.(?:toml|jsonc?|yaml|yml)$/.test(path.basename(file)),
  );
  const rows: RawSurface[] = [];
  for (const file of files) {
    const info = packageContext(path.dirname(file));
    if (!info) continue;
    const source = readFileSync(file, "utf8");
    for (const binding of workerBindingsFromSource(file, source)) {
      rows.push({
        kind: binding.kind,
        name: binding.name,
        sourcePath: toRepoPath(file),
        registrationField:
          binding.kind === "queue"
            ? "wrangler queue binding"
            : "wrangler triggers.crons",
        package: info,
      });
    }
  }
  return rows;
}

function scenarioExportExpressions(ast: ts.SourceFile): ts.Expression[] {
  const expressions: ts.Expression[] = [];
  for (const statement of ast.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      expressions.push(statement.expression);
      continue;
    }
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "scenario" &&
        declaration.initializer
      ) {
        expressions.push(declaration.initializer);
      }
    }
  }
  return expressions;
}

/** Reads the declared lane; absent and live-only scenarios never count as deterministic. */
export function isDeterministicScenarioSource(source: string): boolean {
  return scenarioMetadataFromSource(source).lane === "pr-deterministic";
}

export function scenarioMetadataFromSource(source: string): {
  id: string | null;
  plugins: string[];
  runtimeSurfaceIds: string[];
  lane: string | null;
} {
  const cached = SCENARIO_METADATA_CACHE.get(source);
  if (cached) return cached;
  const ast = ts.createSourceFile(
    "scenario.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = new Map<string, ts.Expression>();
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const resolveScenarioObject = (
    expression: ts.Expression,
  ): ts.ObjectLiteralExpression | null => {
    const current = unwrap(expression);
    if (ts.isObjectLiteralExpression(current)) return current;
    if (ts.isCallExpression(current) && current.arguments.length === 1) {
      const argument = unwrap(current.arguments[0]);
      if (ts.isObjectLiteralExpression(argument)) return argument;
      if (ts.isIdentifier(argument)) {
        const initializer = declarations.get(argument.text);
        return initializer ? resolveScenarioObject(initializer) : null;
      }
    }
    if (ts.isIdentifier(current)) {
      const initializer = declarations.get(current.text);
      return initializer ? resolveScenarioObject(initializer) : null;
    }
    return null;
  };
  const scenarioObject = scenarioExportExpressions(ast)
    .map(resolveScenarioObject)
    .find((candidate) => candidate !== null);
  if (!scenarioObject) {
    const missing = {
      id: null,
      plugins: [],
      runtimeSurfaceIds: [],
      lane: null,
    };
    SCENARIO_METADATA_CACHE.set(source, missing);
    return missing;
  }
  const idProperty = scenarioObject.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property.name) === "id",
  );
  const laneProperty = scenarioObject.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === "lane",
  );
  const id = idProperty ? literalText(unwrap(idProperty.initializer)) : null;
  const lane = laneProperty
    ? literalText(unwrap(laneProperty.initializer))
    : null;
  const plugins = new Set<string>();
  const runtimeSurfaceIds = new Set<string>();
  const requiresProperty = scenarioObject.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === "requires" &&
      ts.isObjectLiteralExpression(unwrap(property.initializer)),
  );
  if (requiresProperty) {
    const requires = unwrap(
      requiresProperty.initializer,
    ) as ts.ObjectLiteralExpression;
    const pluginProperty = requires.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        propertyName(property.name) === "plugins" &&
        ts.isArrayLiteralExpression(unwrap(property.initializer)),
    );
    if (pluginProperty) {
      for (const element of (
        unwrap(pluginProperty.initializer) as ts.ArrayLiteralExpression
      ).elements) {
        const value = literalText(unwrap(element));
        if (value) plugins.add(value);
      }
    }
  }
  const runtimeSurfaceIdsProperty = scenarioObject.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === "runtimeSurfaceIds" &&
      ts.isArrayLiteralExpression(unwrap(property.initializer)),
  );
  if (runtimeSurfaceIdsProperty) {
    for (const element of (
      unwrap(runtimeSurfaceIdsProperty.initializer) as ts.ArrayLiteralExpression
    ).elements) {
      const value = literalText(unwrap(element));
      if (value) runtimeSurfaceIds.add(value);
    }
  }
  const metadata = {
    id,
    plugins: [...plugins].sort(),
    runtimeSurfaceIds: [...runtimeSurfaceIds].sort(),
    lane,
  };
  SCENARIO_METADATA_CACHE.set(source, metadata);
  return metadata;
}

function scenarioRecords(): ScenarioRecord[] {
  const roots = [
    path.join(
      RUNTIME_SURFACE_REPO_ROOT,
      "packages/scenario-runner/test/scenarios",
    ),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/test/scenarios"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins"),
  ];
  const records: ScenarioRecord[] = [];
  for (const root of roots) {
    for (const file of walkFiles(root, (candidate) =>
      candidate.endsWith(".scenario.ts"),
    )) {
      const source = readFileSync(file, "utf8");
      const metadata = scenarioMetadataFromSource(source);
      const id = metadata.id;
      if (!id) continue;
      const lane =
        metadata.lane === "pr-deterministic" ? "deterministic" : "live";
      records.push({
        id,
        file: toRepoPath(file),
        source,
        plugins: metadata.plugins,
        runtimeSurfaceIds: metadata.runtimeSurfaceIds,
        lane,
      });
    }
  }
  return records;
}

function explicitTestRuntimeSurfaceIds(source: string): string[] {
  const ids = new Set<string>();
  for (const match of source.matchAll(
    /\b(?:test|it)(?:\.[A-Za-z]+)?\s*\(\s*["'`]runtime-surface:([^"'`]+)["'`]/g,
  )) {
    ids.add(match[1]);
  }
  return [...ids].sort();
}

function cloudE2eFiles(): Array<{
  file: string;
  source: string;
  runtimeSurfaceIds: string[];
}> {
  const roots = [
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/e2e"),
    path.join(RUNTIME_SURFACE_REPO_ROOT, "packages/cloud/api/test/e2e"),
  ];
  return roots.flatMap((root) =>
    walkFiles(root, (file) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(file)).map(
      (file) => {
        const source = readFileSync(file, "utf8");
        return {
          file: toRepoPath(file),
          source,
          runtimeSurfaceIds: explicitTestRuntimeSurfaceIds(source),
        };
      },
    ),
  );
}

function pluginAliases(row: RawSurface): string[] {
  const base = path.basename(row.package.dir);
  return [row.package.packageName, base, base.replace(/^plugin-/, "")];
}

export function scenarioOwnsSurface(
  _packageDir: string,
  aliases: readonly string[],
  declaredPlugins: readonly string[],
): boolean {
  return declaredPlugins.some((plugin) => aliases.includes(plugin));
}

/** Requires an executable call/assertion shape; name-only fixture text never qualifies. */
export function isExecutableBoundaryEvidence(
  surface: Pick<RawSurface, "kind" | "name">,
  source: string,
  fullSurfaceId?: string,
): boolean {
  let ast = EVIDENCE_AST_CACHE.get(source);
  if (!ast) {
    ast = ts.createSourceFile(
      "evidence.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    EVIDENCE_AST_CACHE.set(source, ast);
  }
  const routeIdentity =
    surface.kind === "route"
      ? /^(DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)\s+(.+)$/.exec(surface.name)
      : null;
  const rawName = routeIdentity ? routeIdentity[2] : surface.name;
  const signal = rawName;
  if (!fullSurfaceId) return false;
  const metadata = scenarioMetadataFromSource(source);
  const scenarioDeclaresId = metadata.runtimeSurfaceIds.includes(fullSurfaceId);
  const scenarioDeclarations = new Map<string, ts.Node>();
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name))
          scenarioDeclarations.set(declaration.name.text, declaration);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      scenarioDeclarations.set(statement.name.text, statement);
    }
  }
  const resolveScenarioRoot = (
    expression: ts.Expression,
    seen = new Set<string>(),
  ): ts.ObjectLiteralExpression | null => {
    const current = unwrap(expression);
    if (ts.isObjectLiteralExpression(current)) return current;
    if (ts.isCallExpression(current) && current.arguments.length === 1) {
      return resolveScenarioRoot(unwrap(current.arguments[0]), seen);
    }
    if (ts.isIdentifier(current) && !seen.has(current.text)) {
      seen.add(current.text);
      const declaration = scenarioDeclarations.get(current.text);
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
      ) {
        return resolveScenarioRoot(declaration.initializer, seen);
      }
    }
    return null;
  };
  const scenarioRoot = scenarioDeclaresId
    ? scenarioExportExpressions(ast)
        .map((expression) => resolveScenarioRoot(expression))
        .find((candidate) => candidate !== null)
    : null;
  const resolveScenarioArray = (
    expression: ts.Expression,
  ): ts.ArrayLiteralExpression | null => {
    const current = unwrap(expression);
    if (ts.isArrayLiteralExpression(current)) return current;
    if (ts.isIdentifier(current)) {
      const declaration = scenarioDeclarations.get(current.text);
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer
      ) {
        const initializer = unwrap(declaration.initializer);
        return ts.isArrayLiteralExpression(initializer) ? initializer : null;
      }
    }
    return null;
  };
  const scenarioArray = (key: string): ts.ArrayLiteralExpression | null => {
    if (!scenarioRoot) return null;
    const property = scenarioRoot.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        propertyName(candidate.name) === key,
    );
    return property ? resolveScenarioArray(property.initializer) : null;
  };
  const scenarioAssertionReachable = new Set<ts.Node>();
  if (scenarioRoot) {
    const expandedDeclarations = new Set<ts.Node>();
    const isReferenceIdentifier = (node: ts.Node): node is ts.Identifier =>
      ts.isIdentifier(node) &&
      !ts.isDeclarationName(node) &&
      !(
        ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
      );
    const collect = (node: ts.Node): void => {
      if (scenarioAssertionReachable.has(node)) return;
      if (ts.isFunctionDeclaration(node) && !expandedDeclarations.has(node)) {
        return;
      }
      scenarioAssertionReachable.add(node);
      if (isReferenceIdentifier(node)) {
        const declaration = scenarioDeclarations.get(node.text);
        if (declaration && !expandedDeclarations.has(declaration)) {
          expandedDeclarations.add(declaration);
          collect(declaration);
        }
      }
      ts.forEachChild(node, collect);
    };
    for (const property of scenarioRoot.properties) {
      if (
        ts.isMethodDeclaration(property) &&
        ["finalChecks", "checks", "assertions"].includes(
          propertyName(property.name) ?? "",
        )
      ) {
        collect(property);
      }
    }
    for (const turn of scenarioArray("turns")?.elements ?? []) {
      if (!ts.isObjectLiteralExpression(turn)) continue;
      for (const property of turn.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ["assertTurn", "assertResponse"].includes(
            propertyName(property.name) ?? "",
          )
        ) {
          collect(property.initializer);
        }
      }
    }
    for (const key of ["finalChecks", "checks", "assertions"]) {
      for (const check of scenarioArray(key)?.elements ?? []) {
        if (!ts.isObjectLiteralExpression(check)) {
          collect(check);
          continue;
        }
        for (const property of check.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ["predicate", "check", "assertion"].includes(
              propertyName(property.name) ?? "",
            )
          ) {
            collect(property.initializer);
          }
        }
      }
    }
  }
  let testDeclaresId = false;
  const findTestDeclaration = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      /^(?:test|it)(?:\.|$)/.test(node.expression.getText(ast)) &&
      node.arguments[0] &&
      literalText(unwrap(node.arguments[0])) ===
        `runtime-surface:${fullSurfaceId}`
    ) {
      testDeclaresId = true;
    }
    if (!testDeclaresId) ts.forEachChild(node, findTestDeclaration);
  };
  findTestDeclaration(ast);
  if (!scenarioDeclaresId && !testDeclaresId) return false;
  const isTestCallback = (fn: ts.Node): boolean => {
    const parent = fn.parent;
    return (
      ts.isCallExpression(parent) &&
      /^(?:test|it)(?:\.|$)/.test(parent.expression.getText(ast)) &&
      Boolean(
        parent.arguments[0] &&
          literalText(unwrap(parent.arguments[0])) ===
            `runtime-surface:${fullSurfaceId}`,
      )
    );
  };
  const isScenarioCallback = (fn: ts.Node): boolean => {
    return scenarioDeclaresId && scenarioAssertionReachable.has(fn);
  };
  const executable = (node: ts.Node): boolean => {
    let parent: ts.Node | undefined = node.parent;
    while (parent) {
      if (ts.isFunctionLike(parent))
        return isTestCallback(parent) || isScenarioCallback(parent);
      parent = parent.parent;
    }
    return scenarioDeclaresId;
  };
  const containsExactLiteral = (node: ts.Node, value: string): boolean => {
    if (literalText(unwrap(node)) === value) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsExactLiteral(child, value)) found = true;
    });
    return found;
  };
  if (
    scenarioRoot &&
    (surface.kind === "action" || surface.kind === "subaction")
  ) {
    const subactionSignal =
      rawName.split(/[_/]/).at(-1)?.toLowerCase() ?? rawName.toLowerCase();
    const matchesSubactionData = (
      object: ts.ObjectLiteralExpression,
    ): boolean =>
      object.properties.some((property) => {
        if (!ts.isPropertyAssignment(property)) return false;
        const key = propertyName(property.name) ?? "";
        if (["assertTurn", "assertResponse", "predicate"].includes(key))
          return false;
        const value = unwrap(property.initializer);
        if (
          ["action", "operation"].includes(key) &&
          literalText(value)?.toLowerCase() === subactionSignal
        ) {
          return true;
        }
        return (
          ts.isObjectLiteralExpression(value) && matchesSubactionData(value)
        );
      });
    for (const turn of scenarioArray("turns")?.elements ?? []) {
      if (!ts.isObjectLiteralExpression(turn)) continue;
      const properties = new Map(
        turn.properties
          .filter(ts.isPropertyAssignment)
          .map((property) => [propertyName(property.name), property] as const),
      );
      const assertionProperty =
        properties.get("assertTurn") ?? properties.get("assertResponse");
      const assertion = assertionProperty
        ? unwrap(assertionProperty.initializer)
        : null;
      const hasExecutableAssertion =
        assertion !== null &&
        (ts.isFunctionLike(assertion) ||
          ts.isIdentifier(assertion) ||
          ts.isCallExpression(assertion));
      if (!hasExecutableAssertion) continue;
      const actionNameProperty = properties.get("actionName");
      const actionName = actionNameProperty
        ? literalText(unwrap(actionNameProperty.initializer))
        : null;
      if (surface.kind === "action" && actionName === rawName) return true;
      if (surface.kind === "subaction" && matchesSubactionData(turn))
        return true;
    }
  }
  if (surface.kind === "route") {
    if (!routeIdentity) return false;
    const expectedMethod = routeIdentity[1];
    const expectedPath = routeIdentity[2];
    const fetchTargetPath = (node: ts.Expression): string | null => {
      const target = unwrap(node);
      const literal = literalText(target);
      if (literal !== null) return literal;
      if (
        ts.isNewExpression(target) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === "URL" &&
        target.arguments?.[0]
      ) {
        return literalText(unwrap(target.arguments[0]));
      }
      return null;
    };
    const fetchMethod = (node: ts.CallExpression): string | null => {
      const options = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
      if (!options) return "GET";
      if (!ts.isObjectLiteralExpression(options)) return null;
      const methodProperty = options.properties.find(
        (candidate): candidate is ts.PropertyAssignment =>
          ts.isPropertyAssignment(candidate) &&
          propertyName(candidate.name) === "method",
      );
      if (!methodProperty) return "GET";
      return (
        literalText(unwrap(methodProperty.initializer))?.toUpperCase() ?? null
      );
    };
    const matchesExplicitFetch = (node: ts.CallExpression): boolean => {
      const callee = node.expression;
      const isFetch =
        (ts.isIdentifier(callee) && callee.text === "fetch") ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          ["globalThis", "window"].includes(callee.expression.text) &&
          callee.name.text === "fetch");
      return Boolean(
        isFetch &&
          node.arguments[0] &&
          fetchTargetPath(node.arguments[0]) === expectedPath &&
          fetchMethod(node) === expectedMethod,
      );
    };
    let routeProved = false;
    const inspect = (node: ts.Node): void => {
      if (routeProved || !ts.isCallExpression(node) || !executable(node)) {
        ts.forEachChild(node, inspect);
        return;
      }
      if (
        /^(?:expect|assert(?:Equal|Deep|Response))$/.test(
          node.expression.getText(ast),
        )
      ) {
        const inspectAssertion = (candidate: ts.Node): void => {
          if (
            ts.isCallExpression(candidate) &&
            matchesExplicitFetch(candidate)
          ) {
            routeProved = true;
          }
          if (!routeProved) ts.forEachChild(candidate, inspectAssertion);
        };
        for (const argument of node.arguments) inspectAssertion(argument);
      }
      if (scenarioAssertionReachable.has(node) && matchesExplicitFetch(node)) {
        routeProved = true;
      }
      if (!routeProved) ts.forEachChild(node, inspect);
    };
    inspect(ast);
    return routeProved;
  }
  let proved = false;
  const visit = (node: ts.Node): void => {
    if (proved || !ts.isCallExpression(node) || !executable(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    const callee = node.expression.getText(ast);
    const callText = node.getText(ast);
    if (!containsExactLiteral(node, signal)) {
      ts.forEachChild(node, visit);
      return;
    }
    if (
      (surface.kind === "action" || surface.kind === "subaction") &&
      /(?:assertTurn|assertResponse|finalChecks)/.test(callee) &&
      /actionCalled|selectedAction|selectedActionArguments/.test(callText)
    ) {
      proved = true;
      return;
    }
    const boundaryApis: Record<string, RegExp> = {
      route: /(?:request|fetch|client|page\.request)(?:\.|$)/i,
      service: /(?:getService|registerService)/i,
      provider: /(?:getProvider|providers?\.(?:find|get))/i,
      "connector-ingress": /(?:handleMessage|inbound|webhook)/i,
      "connector-egress": /(?:dispatch|deliver|sendMessage)/i,
      "scheduled-worker": /(?:scheduled|worker|dispatch)/i,
      queue: /(?:queue|dispatch|send)/i,
      "cloud-service": /(?:request|fetch|dispatch)/i,
      "event-handler": /(?:emitEvent|emit|publish)/i,
      evaluator: /evaluate/i,
      "response-handler-evaluator": /evaluate/i,
      "response-handler-field-evaluator": /evaluate/i,
      view: /(?:getView|listViews)/i,
      "model-handler": /(?:useModel|registerModel)/i,
      "native-bridge": /(?:invoke|registerPlugin)/i,
      action: /$a/,
      subaction: /$a/,
    };
    if (/^(?:expect|assert(?:Equal|Deep|Response))$/.test(callee)) {
      const inspectArgument = (candidate: ts.Node): void => {
        const candidateCallee = ts.isCallExpression(candidate)
          ? candidate.expression.getText(ast)
          : "";
        const boundaryCall =
          surface.kind === "route"
            ? /(?:request|fetch|client)/i.test(candidateCallee)
            : Boolean(boundaryApis[surface.kind]?.test(candidateCallee));
        if (
          ts.isCallExpression(candidate) &&
          boundaryCall &&
          candidate.arguments.some((argument) =>
            containsExactLiteral(argument, signal),
          )
        )
          proved = true;
        if (!proved) ts.forEachChild(candidate, inspectArgument);
      };
      for (const argument of node.arguments) inspectArgument(argument);
      if (proved) return;
    }
    if (!boundaryApis[surface.kind]?.test(callee)) {
      ts.forEachChild(node, visit);
      return;
    }
    if (scenarioAssertionReachable.has(node)) {
      proved = true;
      return;
    }
    let ancestor: ts.Node | undefined = node.parent;
    while (ancestor && !ts.isExpressionStatement(ancestor)) {
      if (
        ts.isCallExpression(ancestor) &&
        /^(?:expect|assert(?:Equal|Deep|Response))$/.test(
          ancestor.expression.getText(ast),
        )
      ) {
        proved = true;
        return;
      }
      ancestor = ancestor.parent;
    }
  };
  visit(ast);
  return proved;
}

function defaultWorkstream(
  surface: RawSurface,
): RuntimeSurfaceRow["workstream"] {
  if (
    surface.kind === "native-bridge" ||
    surface.package.platformRequirements.includes("native-host")
  ) {
    return "#23270";
  }
  if (surface.kind === "model-handler") return "#22901";
  if (
    ["provider", "connector-ingress", "connector-egress"].includes(surface.kind)
  )
    return "#22899";
  if (
    surface.package.dir.startsWith("packages/cloud/") &&
    ["route", "cloud-service", "scheduled-worker", "queue"].includes(
      surface.kind,
    )
  ) {
    return "#22904";
  }
  if (surface.kind === "scheduled-worker" || surface.kind === "queue")
    return "#22902";
  if (surface.kind === "route" || surface.kind === "cloud-service")
    return "#22904";
  return "#23268";
}

function uniqueRawSurfaces(rows: RawSurface[]): RawSurface[] {
  const byId = new Map<string, RawSurface>();
  for (const row of rows) {
    if (!row.name.trim()) continue;
    const normalized = normalizeName(row.name);
    if (
      !normalized ||
      /^(?:name|actions|providers|routes|specs|modelType)$/i.test(normalized) ||
      /(?:dynamic:|=>|\?\?|\.filter\b|\.flatMap\b|\.map\b|\bnew Set\b)/.test(
        normalized,
      )
    )
      continue;
    const id = runtimeSurfaceId(row);
    const existing = byId.get(id);
    if (!existing || row.sourcePath.localeCompare(existing.sourcePath) < 0) {
      byId.set(id, row);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const left = `${a.package.packageName}:${a.kind}:${a.name}:${a.sourcePath}`;
    const right = `${b.package.packageName}:${b.kind}:${b.name}:${b.sourcePath}`;
    return left.localeCompare(right);
  });
}

export function discoverRuntimeSurfaces(): RawSurface[] {
  const rows: RawSurface[] = [];
  for (const dir of workspacePackageDirs()) {
    const info = packageContext(dir);
    if (!info) continue;
    rows.push(...extractPluginSurfaces(dir, info));
    rows.push(...collectCallRegisteredSurfaces(dir, info));
  }
  rows.push(
    ...hostAssemblySurfaces(),
    ...cloudRouteSurfaces(),
    ...cloudServiceSurfaces(),
    ...workerBindingSurfaces(),
  );
  return uniqueRawSurfaces(rows);
}

export function classifyRuntimeSurfaceStatus(input: {
  kind: RuntimeSurfaceKind;
  nativeHostRequired: boolean;
  hasBoundaryEvidence: boolean;
  dependencyDisposition: RuntimeSurfaceRow["dependencyDisposition"];
}): RuntimeSurfaceStatus {
  const dependencyEligible = ["local-only", "mock-owned"].includes(
    input.dependencyDisposition,
  );
  if (input.hasBoundaryEvidence && dependencyEligible) return "covered";
  if (input.kind === "native-bridge" || input.nativeHostRequired) {
    return "platform-deferred";
  }
  if (
    [
      "provider",
      "connector-ingress",
      "connector-egress",
      "model-handler",
    ].includes(input.kind) &&
    ["mock-missing", "unresolved"].includes(input.dependencyDisposition)
  ) {
    return "provider-qualified-only";
  }
  return "uncovered";
}

export function buildRuntimeSurfaceInventory(
  options: { generatedAt?: string; sourceRevision?: string } = {},
): RuntimeSurfaceInventory {
  const scenarios = scenarioRecords();
  const cloudCells = cloudE2eFiles();
  const raw = discoverRuntimeSurfaces();
  const dependencyCatalog = loadRuntimeDependencyCatalog();
  validateRuntimeDependencyCatalog(
    raw.map((surface) => ({
      packageName: surface.package.packageName,
      kind: surface.kind,
      id: runtimeSurfaceId(surface),
      sourcePath: surface.sourcePath,
    })),
    dependencyCatalog,
  );
  const rows = raw.map((surface): RuntimeSurfaceRow => {
    const id = runtimeSurfaceId(surface);
    const aliases = pluginAliases(surface);
    const matchingScenarios = scenarios.filter(
      (scenario) =>
        scenarioOwnsSurface(surface.package.dir, aliases, scenario.plugins) &&
        scenario.runtimeSurfaceIds.includes(id) &&
        isExecutableBoundaryEvidence(surface, scenario.source, id),
    );
    const matchingCells = cloudCells.filter(
      (cell) =>
        cell.runtimeSurfaceIds.includes(id) &&
        isExecutableBoundaryEvidence(surface, cell.source, id),
    );
    const deterministic = matchingScenarios.filter(
      (scenario) => scenario.lane === "deterministic",
    );
    const live = matchingScenarios.filter(
      (scenario) => scenario.lane === "live",
    );
    const boundaryArtifacts = [
      ...new Set([
        ...deterministic.map((scenario) => scenario.file),
        ...matchingCells.map((cell) => cell.file),
      ]),
    ].sort();
    const runtimeDependencies = resolveRuntimeDependencies(
      surface.package.packageName,
      surface.kind,
      dependencyCatalog,
      id,
      surface.sourcePath,
    );
    const hasBoundaryEvidence = boundaryArtifacts.length > 0;
    const unresolvedDependencies =
      runtimeDependencies.dependencyDisposition === "unresolved";
    const status = classifyRuntimeSurfaceStatus({
      kind: surface.kind,
      nativeHostRequired:
        surface.package.platformRequirements.includes("native-host"),
      hasBoundaryEvidence,
      dependencyDisposition: runtimeDependencies.dependencyDisposition,
    });
    const covered = status === "covered";
    const reason = covered
      ? "Executable keyless scenario or Cloud E2E cell exercises the exact registered boundary."
      : status === "platform-deferred"
        ? `${surface.package.packageName} ${surface.kind} ${normalizeName(surface.name)} requires a native host; the report records it without claiming synthetic coverage.`
        : status === "provider-qualified-only"
          ? unresolvedDependencies
            ? `${surface.package.packageName} ${surface.kind} ${normalizeName(surface.name)} has an unresolved external-service boundary; provider qualification is required until exact collaborators and mock ownership are declared.`
            : `${surface.package.packageName} ${surface.kind} ${normalizeName(surface.name)} has an explicit external protocol but no owned mock source; the report records the gap without claiming coverage.`
          : hasBoundaryEvidence
            ? `${surface.package.packageName} ${surface.kind} ${normalizeName(surface.name)} has executable boundary evidence, but its ${runtimeDependencies.dependencyDisposition} dependency disposition cannot qualify as synthetic coverage.`
            : runtimeDependencies.dependencyDisposition === "unresolved"
              ? `${surface.package.packageName} ${surface.kind} ${normalizeName(surface.name)} has an explicitly unresolved per-surface dependency boundary; the report refuses to classify it as local-only.`
              : `${surface.package.packageName} ${surface.kind} ${normalizeName(surface.name)} has no executable synthetic-world boundary artifact in this report.`;
    const providerQualified = status === "provider-qualified-only";
    const mockAvailable = deterministic.length > 0;
    const partialMock = !mockAvailable && matchingCells.length > 0;
    return {
      id,
      kind: surface.kind,
      surfaceName: normalizeName(surface.name),
      owner: surface.package.owner,
      packageName: surface.package.packageName,
      packageDir: surface.package.dir,
      sourcePath: surface.sourcePath,
      registrationField: surface.registrationField,
      runtimeRequirements: surface.package.runtimeRequirements,
      platformRequirements: surface.package.platformRequirements,
      packageDependencies: surface.package.packageDependencies,
      ...runtimeDependencies,
      mockAvailability: mockAvailable
        ? "available"
        : partialMock
          ? "partial"
          : "missing",
      mockFidelity: mockAvailable
        ? "Production runtime registration is exercised and the exact surface signal is asserted; protocol fidelity remains owned by the referenced scenario."
        : partialMock
          ? "A Cloud E2E cell names this boundary, but no deterministic scenario owns it."
          : "No executable deterministic artifact names this registered boundary.",
      resetSupport: mockAvailable ? "partial" : "missing",
      deterministicScenarioIds: deterministic
        .map((scenario) => scenario.id)
        .sort(),
      liveModelScenarioIds: live.map((scenario) => scenario.id).sort(),
      cloudE2eCells: matchingCells.map((cell) => cell.file).sort(),
      evidenceClass: covered
        ? "synthetic"
        : providerQualified
          ? "provider-qualified"
          : "none",
      boundaryArtifacts,
      boundarySignals: covered ? [id, normalizeName(surface.name)] : [],
      workstream: defaultWorkstream(surface),
      status,
      reason,
    };
  });
  const byKind: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byDependencyDisposition: Record<string, number> = {};
  const gaps = {
    byOwner: {} as Record<string, string[]>,
    byExternalService: {} as Record<string, string[]>,
    byMockOwner: {} as Record<string, string[]>,
    byScenarioLane: {} as Record<string, string[]>,
    byWorkstream: {} as Record<string, string[]>,
  };
  const appendGap = (
    group: Record<string, string[]>,
    key: string,
    id: string,
  ): void => {
    const ids = group[key] ?? [];
    ids.push(id);
    group[key] = ids;
  };
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byDependencyDisposition[row.dependencyDisposition] =
      (byDependencyDisposition[row.dependencyDisposition] ?? 0) + 1;
    if (row.status === "covered") continue;
    appendGap(gaps.byOwner, row.owner, row.id);
    const services =
      row.dependencyDisposition === "unresolved"
        ? ["unresolved"]
        : row.externalServiceDependencies.length > 0
          ? row.externalServiceDependencies.map((dependency) => dependency.id)
          : ["none"];
    for (const service of services) {
      appendGap(gaps.byExternalService, service, row.id);
    }
    const mockOwners =
      row.dependencyDisposition === "unresolved"
        ? ["unresolved"]
        : row.mockDependencies.length > 0
          ? row.mockDependencies.map(
              (dependency) => dependency.owner ?? "missing",
            )
          : ["not-applicable"];
    for (const owner of mockOwners) {
      appendGap(gaps.byMockOwner, owner, row.id);
    }
    appendGap(gaps.byScenarioLane, "missing-deterministic", row.id);
    appendGap(gaps.byWorkstream, row.workstream, row.id);
  }
  for (const group of [
    gaps.byOwner,
    gaps.byExternalService,
    gaps.byMockOwner,
    gaps.byScenarioLane,
    gaps.byWorkstream,
  ]) {
    for (const ids of Object.values(group)) ids.sort();
  }
  const packages = workspacePackageDirs()
    .map(packageContext)
    .filter((entry): entry is PackageContext => entry !== null)
    .map((entry): RuntimePackageRecord => {
      const registeredSurfaceIds = rows
        .filter((row) => row.packageDir === entry.dir)
        .map((row) => row.id)
        .sort();
      const hasSurfaces = registeredSurfaceIds.length > 0;
      return {
        owner: entry.owner,
        packageName: entry.packageName,
        packageDir: entry.dir,
        runtimeRequirements: entry.runtimeRequirements,
        platformRequirements: entry.platformRequirements,
        packageDependencies: entry.packageDependencies,
        registeredSurfaceIds,
        registrationState: hasSurfaces
          ? "registered-surfaces"
          : "no-runtime-registration",
        reason: hasSurfaces
          ? "Production registration or export analysis found the listed canonical runtime surfaces."
          : "Report-only observation: the scanner found no reachable production runtime registration; this is not a product exemption.",
      };
    });
  return {
    schema: RUNTIME_SURFACE_SCHEMA,
    generatedAt: options.generatedAt ?? "1970-01-01T00:00:00.000Z",
    sourceRevision: options.sourceRevision ?? "report-only-working-tree",
    packages,
    rows,
    summary: {
      total: rows.length,
      byKind,
      byStatus,
      byDependencyDisposition,
    },
    gaps,
  };
}
