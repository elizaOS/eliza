import { describe, expect, it } from "vitest";
import {
  buildConnectorAccountDraftFromGrant,
  type CalendarCacheMigrationResult,
  type ConnectorAccountCredentialRow,
  type ConnectorAccountMigrationAccountRow,
  type ConnectorAccountMigrationDraft,
  type LegacyLifeConnectorGrantRow,
  type LifeConnectorGrantMigrationStore,
  lifeOpsConnectorGrantMigrationConstants,
  mapLifeOpsConnectorSideToPurpose,
  migrateLifeConnectorGrantsToConnectorAccounts,
} from "./connector-account-migration";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

interface FakeCalendarEvent {
  id: string;
  grantId: string | null;
  connectorAccountId: string | null;
  marked: boolean;
}

interface FakeCalendarSyncState {
  id: string;
  grantId: string | null;
  connectorAccountId: string | null;
  marked: boolean;
}

function grant(
  overrides: Partial<LegacyLifeConnectorGrantRow>,
): LegacyLifeConnectorGrantRow {
  const now = "2026-05-08T00:00:00.000Z";
  return {
    id: "grant-owner",
    agentId: AGENT_ID,
    provider: "google",
    connectorAccountId: null,
    side: "owner",
    identityJson: JSON.stringify({
      sub: "google-sub-owner",
      email: "owner@example.com",
      displayName: "Owner Example",
    }),
    identityEmail: "owner@example.com",
    grantedScopesJson: JSON.stringify(["calendar.readonly", "gmail.readonly"]),
    capabilitiesJson: JSON.stringify([
      "google.calendar.read",
      "google.gmail.triage",
    ]),
    tokenRef: "tokens/google/owner.json",
    mode: "oauth",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadataJson: JSON.stringify({ source: "legacy-test" }),
    lastRefreshAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function emptyCalendarResult(): CalendarCacheMigrationResult {
  return {
    backfilledEvents: 0,
    backfilledSyncStates: 0,
    markedEventsForPurgeResync: 0,
    markedSyncStatesForPurgeResync: 0,
    purgedEvents: 0,
    purgedSyncStates: 0,
  };
}

class FakeMigrationStore implements LifeConnectorGrantMigrationStore {
  accounts: ConnectorAccountMigrationAccountRow[] = [];
  credentials: ConnectorAccountCredentialRow[] = [];
  events: FakeCalendarEvent[] = [];
  syncStates: FakeCalendarSyncState[] = [];

  constructor(public grants: LegacyLifeConnectorGrantRow[]) {}

  async listLegacyConnectorGrants(agentId?: string) {
    return agentId
      ? this.grants.filter((item) => item.agentId === agentId)
      : [...this.grants];
  }

  async listConnectorAccounts(agentIds: readonly string[]) {
    const allowed = new Set(agentIds);
    return this.accounts.filter((account) => allowed.has(account.agentId));
  }

  async listConnectorAccountCredentials(accountIds: readonly string[]) {
    const allowed = new Set(accountIds);
    return this.credentials.filter((credential) =>
      allowed.has(credential.accountId),
    );
  }

  async upsertConnectorAccount(draft: ConnectorAccountMigrationDraft) {
    const existing = this.accounts.find(
      (account) =>
        account.agentId === draft.agentId &&
        account.provider === draft.provider &&
        account.accountKey === draft.accountKey,
    );
    if (existing) {
      existing.metadata = { ...existing.metadata, ...draft.metadata };
      return existing;
    }
    const account = {
      id: `00000000-0000-4000-8000-${String(this.accounts.length + 10).padStart(
        12,
        "0",
      )}`,
      agentId: draft.agentId,
      provider: draft.provider,
      accountKey: draft.accountKey,
      metadata: draft.metadata,
    };
    this.accounts.push(account);
    return account;
  }

  async setConnectorAccountCredentialRef(args: {
    accountId: string;
    tokenRef: string;
  }) {
    const existing = this.credentials.find(
      (credential) =>
        credential.accountId === args.accountId &&
        credential.credentialType ===
          lifeOpsConnectorGrantMigrationConstants.legacyTokenCredentialType,
    );
    if (existing) {
      existing.vaultRef = args.tokenRef;
      return;
    }
    this.credentials.push({
      accountId: args.accountId,
      credentialType:
        lifeOpsConnectorGrantMigrationConstants.legacyTokenCredentialType,
      vaultRef: args.tokenRef,
    });
  }

  async updateLegacyGrantConnectorAccountId(args: {
    grantId: string;
    connectorAccountId: string;
  }) {
    const target = this.grants.find((item) => item.id === args.grantId);
    if (target) target.connectorAccountId = args.connectorAccountId;
  }

  async migrateCalendarLegacyCache(args: {
    grantAccountIds: ReadonlyMap<string, string>;
    dryRun: boolean;
    purge: boolean;
  }) {
    const result = emptyCalendarResult();
    for (const event of this.events) {
      const accountId = event.grantId
        ? args.grantAccountIds.get(event.grantId)
        : undefined;
      if (accountId && !event.connectorAccountId) {
        result.backfilledEvents += 1;
        if (!args.dryRun) event.connectorAccountId = accountId;
      }
    }
    for (const syncState of this.syncStates) {
      const accountId = syncState.grantId
        ? args.grantAccountIds.get(syncState.grantId)
        : undefined;
      if (accountId && !syncState.connectorAccountId) {
        result.backfilledSyncStates += 1;
        if (!args.dryRun) syncState.connectorAccountId = accountId;
      }
    }

    for (const event of this.events) {
      const ambiguous =
        !event.connectorAccountId &&
        (!event.grantId || !args.grantAccountIds.has(event.grantId));
      if (ambiguous) {
        result.markedEventsForPurgeResync += 1;
        if (!args.dryRun) event.marked = true;
      }
    }
    for (const syncState of this.syncStates) {
      const ambiguous =
        !syncState.connectorAccountId &&
        (!syncState.grantId || !args.grantAccountIds.has(syncState.grantId));
      if (ambiguous) {
        result.markedSyncStatesForPurgeResync += 1;
        if (!args.dryRun) syncState.marked = true;
      }
    }

    if (!args.dryRun && args.purge) {
      const eventCountBefore = this.events.length;
      this.events = this.events.filter((event) => !event.marked);
      result.purgedEvents = eventCountBefore - this.events.length;

      const syncCountBefore = this.syncStates.length;
      this.syncStates = this.syncStates.filter((state) => !state.marked);
      result.purgedSyncStates = syncCountBefore - this.syncStates.length;
    }

    return result;
  }
}

describe("LifeOps connector grant migration", () => {
  it("maps owner and agent grant sides to connector account purposes", () => {
    expect(mapLifeOpsConnectorSideToPurpose("owner")).toBe("OWNER");
    expect(mapLifeOpsConnectorSideToPurpose("agent")).toBe("AGENT");

    const ownerDraft = buildConnectorAccountDraftFromGrant(
      grant({ side: "owner" }),
    );
    const agentDraft = buildConnectorAccountDraftFromGrant(
      grant({
        id: "grant-agent",
        side: "agent",
        identityJson: JSON.stringify({
          sub: "google-sub-agent",
          email: "agent@example.com",
        }),
        identityEmail: "agent@example.com",
      }),
    );

    expect(ownerDraft.metadata.lifeops).toMatchObject({ purpose: "OWNER" });
    expect(agentDraft.metadata.lifeops).toMatchObject({ purpose: "AGENT" });
    expect(ownerDraft.capabilities).toContain("google.calendar.read");
    expect(ownerDraft.tokenRef).toBe("tokens/google/owner.json");
  });

  it("supports dry-run without mutating grants, accounts, credentials, or calendar cache", async () => {
    const store = new FakeMigrationStore([
      grant({ id: "grant-owner" }),
      grant({
        id: "grant-agent",
        side: "agent",
        identityJson: JSON.stringify({
          sub: "agent-sub",
          email: "agent@example.com",
        }),
        identityEmail: "agent@example.com",
        tokenRef: "tokens/google/agent.json",
      }),
    ]);
    store.events.push({
      id: "event-1",
      grantId: "grant-owner",
      connectorAccountId: null,
      marked: false,
    });

    const result = await migrateLifeConnectorGrantsToConnectorAccounts(store, {
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      scannedGrants: 2,
      plannedAccounts: 2,
      createdAccounts: 2,
      preservedTokenRefs: 2,
    });
    expect(store.accounts).toHaveLength(0);
    expect(store.credentials).toHaveLength(0);
    expect(store.grants.every((item) => item.connectorAccountId === null)).toBe(
      true,
    );
    expect(store.events[0]?.connectorAccountId).toBeNull();
  });

  it("is idempotent and preserves token refs in connector account credentials", async () => {
    const store = new FakeMigrationStore([
      grant({ id: "grant-owner" }),
      grant({
        id: "grant-agent",
        side: "agent",
        identityJson: JSON.stringify({
          sub: "agent-sub",
          email: "agent@example.com",
        }),
        identityEmail: "agent@example.com",
        tokenRef: "tokens/google/agent.json",
      }),
    ]);

    const first = await migrateLifeConnectorGrantsToConnectorAccounts(store, {
      dryRun: false,
    });
    const second = await migrateLifeConnectorGrantsToConnectorAccounts(store, {
      dryRun: false,
    });

    expect(first.createdAccounts).toBe(2);
    expect(second.createdAccounts).toBe(0);
    expect(second.updatedAccounts).toBe(2);
    expect(store.accounts).toHaveLength(2);
    expect(store.credentials).toHaveLength(2);
    expect(store.credentials.map((item) => item.vaultRef).sort()).toEqual([
      "tokens/google/agent.json",
      "tokens/google/owner.json",
    ]);
    expect(store.grants.every((item) => item.connectorAccountId)).toBe(true);
  });

  it("marks ambiguous calendar cache for purge/resync without deleting by default", async () => {
    const store = new FakeMigrationStore([grant({ id: "grant-owner" })]);
    store.events.push(
      {
        id: "event-mapped",
        grantId: "grant-owner",
        connectorAccountId: null,
        marked: false,
      },
      {
        id: "event-ambiguous",
        grantId: null,
        connectorAccountId: null,
        marked: false,
      },
    );
    store.syncStates.push({
      id: "sync-ambiguous",
      grantId: "missing-grant",
      connectorAccountId: null,
      marked: false,
    });

    const result = await migrateLifeConnectorGrantsToConnectorAccounts(store, {
      dryRun: false,
    });

    expect(result.calendarCache).toMatchObject({
      backfilledEvents: 1,
      markedEventsForPurgeResync: 1,
      markedSyncStatesForPurgeResync: 1,
      purgedEvents: 0,
      purgedSyncStates: 0,
    });
    expect(store.events).toHaveLength(2);
    expect(
      store.events.find((event) => event.id === "event-mapped")
        ?.connectorAccountId,
    ).toBe(store.grants[0]?.connectorAccountId);
    expect(
      store.events.find((event) => event.id === "event-ambiguous")?.marked,
    ).toBe(true);
    expect(store.syncStates[0]?.marked).toBe(true);
  });

  it("purges marked calendar cache only with the explicit purge flag", async () => {
    const store = new FakeMigrationStore([grant({ id: "grant-owner" })]);
    store.events.push({
      id: "event-ambiguous",
      grantId: null,
      connectorAccountId: null,
      marked: false,
    });

    const result = await migrateLifeConnectorGrantsToConnectorAccounts(store, {
      dryRun: false,
      purgeCalendarLegacyCache: true,
    });

    expect(result.calendarCache.purgedEvents).toBe(1);
    expect(store.events).toHaveLength(0);
  });
});
