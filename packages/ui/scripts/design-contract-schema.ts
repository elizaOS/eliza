/**
 * Defines the build-time design dependency graph and exact migration-debt
 * contract shared by the UI design audit and its focused tests.
 */

import type { PageLayoutManifest } from "../../core/src/types/surface-manifest.ts";

export const DESIGN_LAYERS = [
  "token",
  "atom",
  "molecule",
  "organism",
  "page-shell",
] as const;

export type DesignLayer = (typeof DESIGN_LAYERS)[number];
export type DesignNodeId = `${DesignLayer}:${string}`;

export const DESIGN_CAPABILITIES = [
  "paint.foreground",
  "paint.surface",
  "paint.border",
  "paint.radius",
  "paint.elevation",
  "paint.status",
  "paint.action",
  "paint.background",
  "interaction.activate",
  "interaction.input",
  "interaction.select",
  "interaction.drag",
  "interaction.focus-region",
  "layout.local",
  "layout.container",
  "layout.region",
  "layout.viewport",
  "layout.scroll-owner",
  "semantics.landmark",
  "semantics.content",
] as const;

export type DesignCapability = (typeof DESIGN_CAPABILITIES)[number];

export type DesignSourceOwner =
  | { kind: "stylesheet"; file: string; token?: string }
  | { kind: "export"; file: string; symbol: string };

interface BaseDesignNode {
  id: DesignNodeId;
  layer: DesignLayer;
  owner: DesignSourceOwner;
  responsibility: string;
  dependsOn: readonly DesignNodeId[];
  grants: readonly DesignCapability[];
  provenance:
    | "declared"
    | "declared-registry"
    | "derived-atomic-inventory"
    | "derived-molecule-contract"
    | "derived-component-discovery";
}

export interface TokenDesignNode extends BaseDesignNode {
  id: `token:${string}`;
  layer: "token";
  owner: Extract<DesignSourceOwner, { kind: "stylesheet" }>;
  tokenFamilies: readonly string[];
  sourceDigest: string;
  declaredTokenCount: number;
}

export interface AtomDesignNode extends BaseDesignNode {
  id: `atom:${string}`;
  layer: "atom";
  owner: Extract<DesignSourceOwner, { kind: "export" }>;
  atomicKind: string;
  semanticHosts: readonly string[];
}

export interface MoleculeDesignNode extends BaseDesignNode {
  id: `molecule:${string}`;
  layer: "molecule";
  owner: Extract<DesignSourceOwner, { kind: "export" }>;
  requiredRenderedTags: readonly string[];
}

export interface OrganismDesignNode extends BaseDesignNode {
  id: `organism:${string}`;
  layer: "organism";
  owner: Extract<DesignSourceOwner, { kind: "export" }>;
  lifecycleOwner: string;
}

export interface PageShellDesignNode extends BaseDesignNode {
  id: `page-shell:${string}`;
  layer: "page-shell";
  owner: Extract<DesignSourceOwner, { kind: "export" }>;
  supportedLayoutKinds: readonly PageLayoutManifest["kind"][];
  supportedTopologies: readonly ["framed"];
}

export type DesignNode =
  | TokenDesignNode
  | AtomDesignNode
  | MoleculeDesignNode
  | OrganismDesignNode
  | PageShellDesignNode;

export interface DesignGraphFinding {
  rule: string;
  nodeId: DesignNodeId | null;
  owner: string;
  detail: string;
  fingerprint: string;
}

export interface DesignDebtEntry {
  fingerprint: string;
  matchCount: number;
  rule: string;
  owner: string;
  reason: string;
  addedOn: string;
  reviewBy: string;
}

export interface DesignDebtLedger {
  schemaVersion: 1;
  entries: readonly DesignDebtEntry[];
}

export interface DesignDebtComparison {
  newFindings: readonly DesignGraphFinding[];
  staleDebt: readonly DesignDebtEntry[];
  expiredDebt: readonly DesignDebtEntry[];
}

export interface HigherOrderDesignRegistry {
  schemaVersion: 1;
  organisms: readonly OrganismDesignNode[];
  pageShells: readonly PageShellDesignNode[];
}

export const DESIGN_LAYER_RANK: Readonly<Record<DesignLayer, number>> = {
  token: 0,
  atom: 1,
  molecule: 2,
  organism: 3,
  "page-shell": 4,
};

const DESIGN_LAYER_SET = new Set<string>(DESIGN_LAYERS);
const DESIGN_CAPABILITY_SET = new Set<string>(DESIGN_CAPABILITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((entry, index) =>
    requireString(entry, `${context}[${index}]`),
  );
}

function requirePositiveInteger(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value as number;
}

function requireDesignNodeId(value: unknown, context: string): DesignNodeId {
  const id = requireString(value, context);
  if (!/^(token|atom|molecule|organism|page-shell):[^:]+$/.test(id)) {
    throw new Error(`${context} must be a qualified design node id`);
  }
  return id as DesignNodeId;
}

function requireCapabilities(
  value: unknown,
  context: string,
): DesignCapability[] {
  return requireStringArray(value, context).map((capability) => {
    if (!DESIGN_CAPABILITY_SET.has(capability)) {
      throw new Error(`${context} contains unknown capability ${capability}`);
    }
    return capability as DesignCapability;
  });
}

function requireExportOwner(
  value: unknown,
  context: string,
): Extract<DesignSourceOwner, { kind: "export" }> {
  if (!isRecord(value) || value.kind !== "export") {
    throw new Error(`${context} must be an export owner`);
  }
  return {
    kind: "export",
    file: requireString(value.file, `${context}.file`),
    symbol: requireString(value.symbol, `${context}.symbol`),
  };
}

function requireIsoDate(value: unknown, context: string): string {
  const date = requireString(value, context);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !match ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`${context} must use YYYY-MM-DD`);
  }
  return date;
}

export function designOwnerKey(owner: DesignSourceOwner): string {
  return owner.kind === "stylesheet"
    ? `${owner.file}${owner.token ? `:${owner.token}` : ""}`
    : `${owner.file}:${owner.symbol}`;
}

export function validateDesignNodes(nodes: readonly DesignNode[]): void {
  const ids = new Set<string>();
  const owners = new Set<string>();

  for (const node of nodes) {
    if (
      !DESIGN_LAYER_SET.has(node.layer) ||
      !node.id.startsWith(`${node.layer}:`)
    ) {
      throw new Error(`Design node ${node.id} has an invalid layer`);
    }
    if (ids.has(node.id))
      throw new Error(`Duplicate design node id ${node.id}`);
    ids.add(node.id);

    const owner = designOwnerKey(node.owner);
    if (owners.has(owner)) throw new Error(`Duplicate design owner ${owner}`);
    owners.add(owner);

    requireString(node.responsibility, `${node.id}.responsibility`);
    for (const capability of node.grants) {
      if (!DESIGN_CAPABILITY_SET.has(capability)) {
        throw new Error(`${node.id} grants unknown capability ${capability}`);
      }
    }
    if (node.layer === "token" && node.owner.kind !== "stylesheet") {
      throw new Error(`${node.id} must be owned by a stylesheet`);
    }
    if (node.layer !== "token" && node.owner.kind !== "export") {
      throw new Error(`${node.id} must be owned by an exported symbol`);
    }
  }
}

export function parseDesignDebtLedger(value: unknown): DesignDebtLedger {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Design debt ledger requires schemaVersion 1 and entries");
  }

  const fingerprints = new Set<string>();
  const entries: DesignDebtEntry[] = value.entries.map((entry, index) => {
    const context = `Design debt entry ${index}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object`);
    const fingerprint = requireString(
      entry.fingerprint,
      `${context}.fingerprint`,
    );
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error(`${context}.fingerprint must be a SHA-256 digest`);
    }
    if (fingerprints.has(fingerprint)) {
      throw new Error(`Duplicate design debt fingerprint ${fingerprint}`);
    }
    fingerprints.add(fingerprint);
    return {
      fingerprint,
      matchCount: requirePositiveInteger(
        entry.matchCount,
        `${context}.matchCount`,
      ),
      rule: requireString(entry.rule, `${context}.rule`),
      owner: requireString(entry.owner, `${context}.owner`),
      reason: requireString(entry.reason, `${context}.reason`),
      addedOn: requireIsoDate(entry.addedOn, `${context}.addedOn`),
      reviewBy: requireIsoDate(entry.reviewBy, `${context}.reviewBy`),
    };
  });

  return { schemaVersion: 1, entries };
}

export function compareDesignDebt(
  findings: readonly DesignGraphFinding[],
  ledger: DesignDebtLedger,
  now: Date,
): DesignDebtComparison {
  const orderedFindings = [...findings].sort(
    (left, right) =>
      left.fingerprint.localeCompare(right.fingerprint) ||
      left.owner.localeCompare(right.owner) ||
      left.detail.localeCompare(right.detail),
  );
  const findingCount = new Map<string, number>();
  for (const finding of orderedFindings) {
    findingCount.set(
      finding.fingerprint,
      (findingCount.get(finding.fingerprint) ?? 0) + 1,
    );
  }
  const debtByFingerprint = new Map(
    ledger.entries.map((entry) => [entry.fingerprint, entry]),
  );
  const consumed = new Map<string, number>();
  const today = now.toISOString().slice(0, 10);

  return {
    newFindings: orderedFindings.filter((finding) => {
      const count = (consumed.get(finding.fingerprint) ?? 0) + 1;
      consumed.set(finding.fingerprint, count);
      const debt = debtByFingerprint.get(finding.fingerprint);
      return (
        !debt ||
        debt.rule !== finding.rule ||
        debt.owner !== finding.owner ||
        count > debt.matchCount
      );
    }),
    staleDebt: ledger.entries.filter((entry) => {
      const matches = orderedFindings.filter(
        (finding) => finding.fingerprint === entry.fingerprint,
      );
      return (
        matches.length < entry.matchCount ||
        matches.some(
          (finding) =>
            finding.rule !== entry.rule || finding.owner !== entry.owner,
        )
      );
    }),
    expiredDebt: ledger.entries.filter((entry) => entry.reviewBy < today),
  };
}

export function parseHigherOrderDesignRegistry(
  value: unknown,
): HigherOrderDesignRegistry {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.organisms) ||
    !Array.isArray(value.pageShells)
  ) {
    throw new Error(
      "Higher-order design registry requires schemaVersion 1, organisms, and pageShells",
    );
  }

  const organisms: OrganismDesignNode[] = value.organisms.map(
    (entry, index) => {
      const context = `Organism declaration ${index}`;
      if (!isRecord(entry)) throw new Error(`${context} must be an object`);
      const id = requireDesignNodeId(entry.id, `${context}.id`);
      if (!id.startsWith("organism:")) {
        throw new Error(`${context}.id must start with organism:`);
      }
      return {
        id: id as `organism:${string}`,
        layer: "organism",
        owner: requireExportOwner(entry.owner, `${context}.owner`),
        responsibility: requireString(
          entry.responsibility,
          `${context}.responsibility`,
        ),
        dependsOn: requireStringArray(
          entry.dependsOn,
          `${context}.dependsOn`,
        ).map((dependency, dependencyIndex) =>
          requireDesignNodeId(
            dependency,
            `${context}.dependsOn[${dependencyIndex}]`,
          ),
        ),
        grants: requireCapabilities(entry.grants, `${context}.grants`),
        provenance: "declared-registry",
        lifecycleOwner: requireString(
          entry.lifecycleOwner,
          `${context}.lifecycleOwner`,
        ),
      };
    },
  );

  const layoutKinds = new Set(["workspace", "content", "immersive"]);
  const layoutTopologies = new Set(["framed"]);
  const pageShells: PageShellDesignNode[] = value.pageShells.map(
    (entry, index) => {
      const context = `Page-shell declaration ${index}`;
      if (!isRecord(entry)) throw new Error(`${context} must be an object`);
      const id = requireDesignNodeId(entry.id, `${context}.id`);
      if (!id.startsWith("page-shell:")) {
        throw new Error(`${context}.id must start with page-shell:`);
      }
      const supportedLayoutKinds = requireStringArray(
        entry.supportedLayoutKinds,
        `${context}.supportedLayoutKinds`,
      );
      if (supportedLayoutKinds.length === 0) {
        throw new Error(`${context}.supportedLayoutKinds must not be empty`);
      }
      for (const layoutKind of supportedLayoutKinds) {
        if (!layoutKinds.has(layoutKind)) {
          throw new Error(
            `${context}.supportedLayoutKinds contains invalid layout kind ${layoutKind}`,
          );
        }
      }
      const supportedTopologies = requireStringArray(
        entry.supportedTopologies,
        `${context}.supportedTopologies`,
      );
      if (supportedTopologies.length !== 1) {
        throw new Error(`${context}.supportedTopologies must contain framed`);
      }
      for (const topology of supportedTopologies) {
        if (!layoutTopologies.has(topology)) {
          throw new Error(
            `${context}.supportedTopologies contains invalid topology ${topology}`,
          );
        }
      }
      return {
        id: id as `page-shell:${string}`,
        layer: "page-shell",
        owner: requireExportOwner(entry.owner, `${context}.owner`),
        responsibility: requireString(
          entry.responsibility,
          `${context}.responsibility`,
        ),
        dependsOn: requireStringArray(
          entry.dependsOn,
          `${context}.dependsOn`,
        ).map((dependency, dependencyIndex) =>
          requireDesignNodeId(
            dependency,
            `${context}.dependsOn[${dependencyIndex}]`,
          ),
        ),
        grants: requireCapabilities(entry.grants, `${context}.grants`),
        provenance: "declared-registry",
        supportedLayoutKinds:
          supportedLayoutKinds as PageShellDesignNode["supportedLayoutKinds"],
        supportedTopologies: supportedTopologies as ["framed"],
      };
    },
  );

  validateDesignNodes([...organisms, ...pageShells]);
  return { schemaVersion: 1, organisms, pageShells };
}

export function requireStringListForBoundary(
  value: unknown,
  context: string,
): readonly string[] {
  return requireStringArray(value, context);
}
