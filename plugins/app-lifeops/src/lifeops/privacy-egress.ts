import crypto from "node:crypto";
import type {
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";

export const LIFEOPS_EGRESS_DATA_CLASSES = [
  "metadata",
  "snippet",
  "body",
  "recipients_attendees",
  "health",
  "payments",
  "browser_activity",
  "drafts",
  "send_targets",
  "deep_links",
] as const;

export type LifeOpsEgressDataClass =
  (typeof LIFEOPS_EGRESS_DATA_CLASSES)[number];

export const LIFEOPS_ACCOUNT_PRIVACY_SCOPES = [
  "owner_only",
  "metadata_only",
  "shared",
] as const;

export type LifeOpsAccountPrivacyScope =
  (typeof LIFEOPS_ACCOUNT_PRIVACY_SCOPES)[number];

export type LifeOpsEgressActor = "owner" | "non_owner" | "route_owner";

export interface LifeOpsEgressContext {
  actor: LifeOpsEgressActor;
  agentId?: string;
  entityId?: string | null;
}

export interface LifeOpsConnectorAccountPrivacyPolicy {
  id: string;
  agentId: string;
  provider: string;
  connectorAccountId: string;
  visibilityScope: LifeOpsAccountPrivacyScope;
  allowedDataClasses: LifeOpsEgressDataClass[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type LifeOpsConnectorAccountPrivacyInput = Pick<
  LifeOpsConnectorAccountPrivacyPolicy,
  "agentId" | "provider" | "connectorAccountId"
> &
  Partial<
    Pick<
      LifeOpsConnectorAccountPrivacyPolicy,
      "id" | "visibilityScope" | "allowedDataClasses" | "metadata"
    >
  >;

export const DEFAULT_LIFEOPS_ACCOUNT_PRIVACY_SCOPE: LifeOpsAccountPrivacyScope =
  "owner_only";

export const CALENDAR_CONNECTOR_ACCOUNT_MIGRATION_NOTE =
  "Legacy calendar rows without connector_account_id are ambiguous; purge and resync calendar caches before any destructive migration away from grant_id.";

const DATA_CLASS_SET = new Set<string>(LIFEOPS_EGRESS_DATA_CLASSES);
const ACCOUNT_PRIVACY_SCOPE_SET = new Set<string>(
  LIFEOPS_ACCOUNT_PRIVACY_SCOPES,
);

export function isLifeOpsEgressDataClass(
  value: unknown,
): value is LifeOpsEgressDataClass {
  return typeof value === "string" && DATA_CLASS_SET.has(value);
}

export function normalizeLifeOpsEgressDataClasses(
  value: unknown,
): LifeOpsEgressDataClass[] {
  if (!Array.isArray(value)) return [];
  const classes: LifeOpsEgressDataClass[] = [];
  const seen = new Set<LifeOpsEgressDataClass>();
  for (const entry of value) {
    if (!isLifeOpsEgressDataClass(entry) || seen.has(entry)) continue;
    seen.add(entry);
    classes.push(entry);
  }
  return classes;
}

export function normalizeLifeOpsAccountPrivacyScope(
  value: unknown,
): LifeOpsAccountPrivacyScope {
  return typeof value === "string" && ACCOUNT_PRIVACY_SCOPE_SET.has(value)
    ? (value as LifeOpsAccountPrivacyScope)
    : DEFAULT_LIFEOPS_ACCOUNT_PRIVACY_SCOPE;
}

export function createLifeOpsEgressContext(args: {
  isOwner: boolean;
  agentId?: string;
  entityId?: string | null;
}): LifeOpsEgressContext {
  return {
    actor: args.isOwner ? "owner" : "non_owner",
    agentId: args.agentId,
    entityId: args.entityId ?? null,
  };
}

export function createLifeOpsRouteEgressContext(args: {
  agentId?: string;
  adminEntityId?: string | null;
}): LifeOpsEgressContext {
  return {
    actor: "route_owner",
    agentId: args.agentId,
    entityId: args.adminEntityId ?? null,
  };
}

export async function createLifeOpsMessageEgressContext(args: {
  runtime: IAgentRuntime;
  message: Memory;
  hasOwnerAccess: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
}): Promise<LifeOpsEgressContext> {
  return createLifeOpsEgressContext({
    isOwner: await args.hasOwnerAccess(args.runtime, args.message),
    agentId: args.runtime.agentId,
    entityId:
      typeof args.message.entityId === "string" ? args.message.entityId : null,
  });
}

export function canEgress(
  context: LifeOpsEgressContext,
  dataClass: LifeOpsEgressDataClass,
  policy?: LifeOpsConnectorAccountPrivacyPolicy | null,
): boolean {
  if (context.actor === "owner" || context.actor === "route_owner") {
    return true;
  }

  const visibilityScope =
    policy?.visibilityScope ?? DEFAULT_LIFEOPS_ACCOUNT_PRIVACY_SCOPE;
  if (visibilityScope === "owner_only") {
    return false;
  }
  if (visibilityScope === "metadata_only") {
    return dataClass === "metadata";
  }
  return (
    policy?.allowedDataClasses.includes(dataClass) ?? dataClass === "metadata"
  );
}

export function canSurfaceConnectorAccountData(args: {
  context: LifeOpsEgressContext;
  provider: string;
  connectorAccountId?: string | null;
  dataClass: LifeOpsEgressDataClass;
  policy?: LifeOpsConnectorAccountPrivacyPolicy | null;
}): boolean {
  if (args.provider.trim().length === 0) {
    return false;
  }
  if (!args.connectorAccountId) {
    return canEgress(args.context, args.dataClass, args.policy);
  }
  return canEgress(args.context, args.dataClass, args.policy);
}

export function redactTextForEgress(
  value: string | null | undefined,
  args: {
    context: LifeOpsEgressContext;
    dataClass: LifeOpsEgressDataClass;
    policy?: LifeOpsConnectorAccountPrivacyPolicy | null;
    replacement?: string;
  },
): string {
  if (canEgress(args.context, args.dataClass, args.policy)) {
    return value ?? "";
  }
  return args.replacement ?? "[hidden by LifeOps privacy]";
}

export function redactUrlForEgress(
  value: string | null | undefined,
  args: {
    context: LifeOpsEgressContext;
    policy?: LifeOpsConnectorAccountPrivacyPolicy | null;
  },
): string | null {
  if (!value) return null;
  return canEgress(args.context, "deep_links", args.policy) ? value : null;
}

export function filterActionResultForEgress(
  result: ActionResult,
  args: {
    context: LifeOpsEgressContext;
    dataClasses: readonly LifeOpsEgressDataClass[];
    policy?: LifeOpsConnectorAccountPrivacyPolicy | null;
    redactedText?: string;
  },
): ActionResult {
  const canSurface = args.dataClasses.every((dataClass) =>
    canEgress(args.context, dataClass, args.policy),
  );
  if (canSurface) return result;
  return {
    ...result,
    text: args.redactedText ?? "Result hidden by LifeOps privacy policy.",
    data: {
      privacyFiltered: true,
      originalSuccess: result.success,
    },
  };
}

export async function callbackWithPrivacy(
  callback: HandlerCallback | undefined,
  result: ActionResult,
  args: {
    context: LifeOpsEgressContext;
    dataClasses: readonly LifeOpsEgressDataClass[];
    policy?: LifeOpsConnectorAccountPrivacyPolicy | null;
    source: string;
    action: string;
  },
): Promise<ActionResult> {
  const filtered = filterActionResultForEgress(result, args);
  await callback?.({
    text: filtered.text ?? "",
    source: args.source,
    action: args.action,
  });
  return filtered;
}

export function connectorAccountPrivacyKey(
  provider: string,
  connectorAccountId: string,
): string {
  return `${provider}:${connectorAccountId}`;
}

export function mapConnectorAccountPrivacyPolicies(
  policies: readonly LifeOpsConnectorAccountPrivacyPolicy[],
): Map<string, LifeOpsConnectorAccountPrivacyPolicy> {
  return new Map(
    policies.map((policy) => [
      connectorAccountPrivacyKey(policy.provider, policy.connectorAccountId),
      policy,
    ]),
  );
}

export function normalizeConnectorAccountId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function digestConnectorAccountComponent(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readIdentityEmail(identity: Record<string, unknown>): string | null {
  return (
    readString(identity.email) ??
    readString(identity.emailAddress) ??
    readString(identity.primaryEmail)
  );
}

function readIdentityStableId(
  identity: Record<string, unknown>,
): string | null {
  return (
    readString(identity.sub) ??
    readString(identity.id) ??
    readString(identity.accountId) ??
    readString(identity.userId) ??
    readString(identity.phone) ??
    readString(identity.handle)
  );
}

export function deriveConnectorAccountId(args: {
  provider: string;
  side?: string | null;
  identity?: Record<string, unknown> | null;
  identityEmail?: string | null;
  cloudConnectionId?: string | null;
  grantId?: string | null;
}): string | null {
  const provider = args.provider.trim().toLowerCase();
  if (!provider) return null;
  const side = (args.side ?? "owner").trim().toLowerCase() || "owner";
  const identity = args.identity ?? {};
  const email =
    readString(args.identityEmail)?.toLowerCase() ??
    readIdentityEmail(identity)?.toLowerCase();
  if (email) {
    return `${provider}:${side}:email:${digestConnectorAccountComponent(email)}`;
  }

  const stableIdentity = readIdentityStableId(identity);
  if (stableIdentity) {
    return `${provider}:${side}:identity:${digestConnectorAccountComponent(stableIdentity)}`;
  }

  const cloudConnectionId = readString(args.cloudConnectionId);
  if (cloudConnectionId) {
    return `${provider}:${side}:cloud:${digestConnectorAccountComponent(cloudConnectionId)}`;
  }

  return null;
}

export function legacyConnectorAccountIdAlias(args: {
  provider: string;
  side?: string | null;
  grantId: string;
}): string {
  const provider = args.provider.trim().toLowerCase();
  const side = (args.side ?? "owner").trim().toLowerCase() || "owner";
  return `${provider}:${side}:legacy-grant:${digestConnectorAccountComponent(args.grantId)}`;
}

export function deriveConnectorAccountIdFromGrant(
  grant: Pick<
    LifeOpsConnectorGrant,
    | "id"
    | "provider"
    | "side"
    | "identity"
    | "identityEmail"
    | "cloudConnectionId"
    | "metadata"
  >,
): string {
  const explicit = normalizeConnectorAccountId(
    grant.metadata.connectorAccountId,
  );
  if (explicit) return explicit;

  return (
    deriveConnectorAccountId({
      provider: grant.provider,
      side: grant.side,
      identity: grant.identity,
      identityEmail: grant.identityEmail,
      cloudConnectionId: grant.cloudConnectionId,
      grantId: grant.id,
    }) ??
    legacyConnectorAccountIdAlias({
      provider: grant.provider,
      side: grant.side,
      grantId: grant.id,
    })
  );
}

export function createConnectorAccountPrivacyPolicy(
  input: LifeOpsConnectorAccountPrivacyInput,
  now = new Date().toISOString(),
): LifeOpsConnectorAccountPrivacyPolicy {
  return {
    id:
      input.id ??
      `acct_priv_${digestConnectorAccountComponent(
        `${input.agentId}:${input.provider}:${input.connectorAccountId}`,
      )}`,
    agentId: input.agentId,
    provider: input.provider,
    connectorAccountId: input.connectorAccountId,
    visibilityScope: normalizeLifeOpsAccountPrivacyScope(input.visibilityScope),
    allowedDataClasses: normalizeLifeOpsEgressDataClasses(
      input.allowedDataClasses,
    ),
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}
