/** Durable relationship-store assertions shared by the relationship scenario corpus. */

import type {
  CapturedAction,
  ScenarioContext,
} from "@elizaos/scenario-runner/schema";

type ContactRecord = {
  entityId: string;
  preferences?: Record<string, unknown>;
  relationshipGoal?: {
    goalText?: string;
    targetCadenceDays?: number;
  };
  handles?: Array<{ platform?: string; identifier?: string }>;
};

type RelationshipsService = {
  getContact(entityId: string): Promise<ContactRecord | null>;
  searchContacts(criteria: { searchTerm?: string }): Promise<ContactRecord[]>;
};

type RelationshipRuntime = {
  getEntityById(entityId: string): Promise<{
    names?: string[];
    metadata?: Record<string, unknown>;
  } | null>;
  getService(name: string): unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function relationshipsService(ctx: ScenarioContext): RelationshipsService {
  const runtime = ctx.runtime as RelationshipRuntime | undefined;
  const service = runtime?.getService("relationships") as
    | Partial<RelationshipsService>
    | undefined;
  if (
    !service ||
    typeof service.getContact !== "function" ||
    typeof service.searchContacts !== "function"
  ) {
    throw new Error("relationships service is unavailable");
  }
  return service as RelationshipsService;
}

export function successfulContactAction(
  ctx: ScenarioContext,
  op: string,
): CapturedAction | null {
  return (
    ctx.actionsCalled.find((action) => {
      if (action.actionName !== "CONTACT" || action.result?.success !== true) {
        return false;
      }
      return asRecord(action.result.data)?.op === op;
    }) ?? null
  );
}

export async function expectCreatedContact(args: {
  ctx: ScenarioContext;
  name: string;
  metadataIncludes: string;
}): Promise<string | undefined> {
  const action = successfulContactAction(args.ctx, "create");
  const data = asRecord(action?.result?.data);
  const entityId = typeof data?.entityId === "string" ? data.entityId : null;
  if (!entityId) {
    return "expected successful CONTACT create result with an entityId";
  }
  const runtime = args.ctx.runtime as RelationshipRuntime | undefined;
  const entity = await runtime?.getEntityById(entityId);
  if (!entity) {
    return `CONTACT create returned ${entityId}, but durable entity readback found nothing`;
  }
  if (!entity.names?.some((name) => name === args.name)) {
    return `created entity ${entityId} did not retain exact name ${JSON.stringify(args.name)}`;
  }
  if (!JSON.stringify(entity.metadata ?? {}).includes(args.metadataIncludes)) {
    return `created entity ${entityId} did not retain ${JSON.stringify(args.metadataIncludes)} in metadata`;
  }
  return undefined;
}

export async function expectContactPreference(args: {
  ctx: ScenarioContext;
  name: string;
  key: string;
  includes: string;
}): Promise<string | undefined> {
  const action = successfulContactAction(args.ctx, "update");
  if (!action) return "expected successful CONTACT update result";
  const matches = await relationshipsService(args.ctx).searchContacts({
    searchTerm: args.name,
  });
  if (matches.length !== 1) {
    return `expected exactly one durable ${args.name} contact, found ${matches.length}`;
  }
  const contact = await relationshipsService(args.ctx).getContact(
    matches[0].entityId,
  );
  const value = contact?.preferences?.[args.key];
  if (typeof value !== "string" || !value.includes(args.includes)) {
    return `durable contact preference ${args.key} did not include ${JSON.stringify(args.includes)}; saw ${JSON.stringify(value)}`;
  }
  return undefined;
}

export function expectSearchResultNames(args: {
  ctx: ScenarioContext;
  includes: readonly string[];
  excludes: readonly string[];
}): string | undefined {
  const action = successfulContactAction(args.ctx, "search");
  const data = asRecord(action?.result?.data);
  const results = Array.isArray(data?.results) ? data.results : null;
  if (!results) return "expected successful CONTACT search result array";
  const blob = JSON.stringify(results).toLowerCase();
  for (const expected of args.includes) {
    if (!blob.includes(expected.toLowerCase())) {
      return `CONTACT search results omitted ${expected}: ${JSON.stringify(results)}`;
    }
  }
  for (const forbidden of args.excludes) {
    if (blob.includes(forbidden.toLowerCase())) {
      return `CONTACT search results unexpectedly included ${forbidden}: ${JSON.stringify(results)}`;
    }
  }
  return undefined;
}

export function expectSuccessfulActionData(args: {
  ctx: ScenarioContext;
  actionName: string;
  includes: readonly string[];
  excludes?: readonly string[];
}): string | undefined {
  const action = args.ctx.actionsCalled.find(
    (entry) =>
      entry.actionName === args.actionName && entry.result?.success === true,
  );
  if (!action) return `expected successful ${args.actionName} action`;
  const blob = JSON.stringify(action.result?.data ?? {}).toLowerCase();
  for (const expected of args.includes) {
    if (!blob.includes(expected.toLowerCase())) {
      return `${args.actionName} result data omitted ${expected}: ${blob.slice(0, 800)}`;
    }
  }
  for (const forbidden of args.excludes ?? []) {
    if (blob.includes(forbidden.toLowerCase())) {
      return `${args.actionName} result data unexpectedly included ${forbidden}: ${blob.slice(0, 800)}`;
    }
  }
  return undefined;
}

export async function expectRelationshipGoal(args: {
  ctx: ScenarioContext;
  name: string;
  goalIncludes: string;
  cadenceDays: number;
}): Promise<string | undefined> {
  const matches = await relationshipsService(args.ctx).searchContacts({
    searchTerm: args.name,
  });
  if (matches.length !== 1) {
    return `expected exactly one durable ${args.name} contact, found ${matches.length}`;
  }
  const contact = await relationshipsService(args.ctx).getContact(
    matches[0].entityId,
  );
  const goal = contact?.relationshipGoal;
  if (!goal?.goalText?.includes(args.goalIncludes)) {
    return `durable relationship goal did not include ${JSON.stringify(args.goalIncludes)}; saw ${JSON.stringify(goal)}`;
  }
  if (goal.targetCadenceDays !== args.cadenceDays) {
    return `durable relationship cadence expected ${args.cadenceDays} days, saw ${JSON.stringify(goal.targetCadenceDays)}`;
  }
  return undefined;
}

export async function expectImportedContacts(args: {
  ctx: ScenarioContext;
  actionName: string;
  platform: string;
  expectedCount: number;
}): Promise<string | undefined> {
  const structural = expectSuccessfulActionData({
    ctx: args.ctx,
    actionName: args.actionName,
    includes: [args.platform, String(args.expectedCount)],
  });
  if (structural) return structural;
  const contacts = await relationshipsService(args.ctx).searchContacts({});
  const imported = contacts.filter((contact) =>
    contact.handles?.some((handle) => handle.platform === args.platform),
  );
  if (imported.length !== args.expectedCount) {
    return `expected ${args.expectedCount} durable ${args.platform} contacts after import, found ${imported.length}`;
  }
  return undefined;
}
