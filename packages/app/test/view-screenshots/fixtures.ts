/**
 * Per-view, per-state mock fixtures for the LifeOps view screenshot harness.
 *
 * Each fixture set reproduces the exact wire/DTO shapes the view's own jsdom
 * test injects through its fetcher seam. `loading` is a never-resolving promise;
 * `error` is a rejecting fetcher; `empty` / `populated` resolve the relevant
 * shape. The shapes are copied verbatim from the `*.test.tsx` files (or, for the
 * untested Inbox/Goals views, derived directly from the component's wire types).
 *
 * `globalThis.__VIEW_HARNESS_CALENDAR__` is set by the entry for CalendarView
 * (its seam is a hook, not a prop).
 */

const NEVER = () => new Promise<never>(() => {});
const THROW = async (): Promise<never> => {
  throw new Error("Simulated request failure");
};

// ---------------------------------------------------------------------------
// Focus (plugin-blocker) — prop `fetchStatus`, six states.
// ---------------------------------------------------------------------------

function baseStatus(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    active: false,
    hostsFilePath: "/etc/hosts",
    startedAt: null,
    endsAt: null,
    websites: [],
    blockedWebsites: [],
    allowedWebsites: [],
    requestedWebsites: [],
    matchMode: "exact",
    managedBy: null,
    metadata: null,
    scheduledByAgentId: null,
    canUnblockEarly: true,
    requiresElevation: false,
    engine: "hosts-file",
    platform: "linux",
    supportsElevationPrompt: true,
    elevationPromptMethod: "pkexec",
    ...overrides,
  };
}

const focusFixtures: Record<string, () => Record<string, unknown>> = {
  loading: () => ({ fetchStatus: NEVER }),
  error: () => ({ fetchStatus: THROW }),
  unavailable: () => ({
    fetchStatus: async () =>
      baseStatus({
        available: false,
        hostsFilePath: null,
        canUnblockEarly: false,
        requiresElevation: false,
        reason: "Could not find the system hosts file on this machine.",
      }),
  }),
  permission: () => ({
    fetchStatus: async () =>
      baseStatus({
        available: true,
        active: false,
        canUnblockEarly: false,
        requiresElevation: true,
        elevationPromptMethod: "pkexec",
        reason:
          "Eliza needs administrator/root access to edit the system hosts file.",
      }),
  }),
  empty: () => ({
    fetchStatus: async () => baseStatus({ available: true, active: false }),
  }),
  active: () => ({
    fetchStatus: async () =>
      baseStatus({
        available: true,
        active: true,
        startedAt: "2026-06-17T10:00:00.000Z",
        endsAt: "2026-06-17T12:00:00.000Z",
        blockedWebsites: ["x.com", "reddit.com", "news.google.com"],
        requestedWebsites: ["x.com", "reddit.com"],
        matchMode: "subdomain",
        canUnblockEarly: true,
        requiresElevation: false,
      }),
  }),
};

// ---------------------------------------------------------------------------
// Health (plugin-health) — prop `fetchers`, four states.
// ---------------------------------------------------------------------------

function populatedHistory() {
  return {
    episodes: [
      {
        id: "ep-1",
        startedAt: "2026-06-16T23:30:00.000Z",
        endedAt: "2026-06-17T07:15:00.000Z",
        durationMin: 465,
        cycleType: "overnight",
        source: "health",
        confidence: 0.92,
      },
    ],
    summary: {
      cycleCount: 6,
      averageDurationMin: 452,
      overnightCount: 6,
      napCount: 0,
      openCount: 0,
    },
    windowDays: 14,
    includeNaps: true,
  };
}

function emptyHistory() {
  return {
    episodes: [],
    summary: {
      cycleCount: 0,
      averageDurationMin: null,
      overnightCount: 0,
      napCount: 0,
      openCount: 0,
    },
    windowDays: 14,
    includeNaps: true,
  };
}

const HEALTH_REGULARITY = {
  sri: 78.4,
  classification: "regular",
  bedtimeStddevMin: 42,
  wakeStddevMin: 31,
  midSleepStddevMin: 36,
  sampleSize: 6,
  windowDays: 14,
};

const HEALTH_BASELINE = {
  medianBedtimeLocalHour: 23.5,
  medianWakeLocalHour: 7.25,
  medianSleepDurationMin: 452,
  bedtimeStddevMin: 42,
  wakeStddevMin: 31,
  sampleSize: 6,
  windowDays: 14,
};

function healthFetchers(history: () => Record<string, unknown>) {
  return {
    fetchHistory: async () => history(),
    fetchRegularity: async () => HEALTH_REGULARITY,
    fetchBaseline: async () => HEALTH_BASELINE,
  };
}

const healthFixtures: Record<string, () => Record<string, unknown>> = {
  loading: () => ({
    fetchers: {
      fetchHistory: NEVER,
      fetchRegularity: NEVER,
      fetchBaseline: NEVER,
    },
  }),
  error: () => ({
    fetchers: {
      fetchHistory: THROW,
      fetchRegularity: async () => HEALTH_REGULARITY,
      fetchBaseline: async () => HEALTH_BASELINE,
    },
  }),
  empty: () => ({ fetchers: healthFetchers(emptyHistory), ownerName: "Dana" }),
  populated: () => ({
    fetchers: healthFetchers(populatedHistory),
    ownerName: "Dana",
  }),
};

// ---------------------------------------------------------------------------
// Finances (plugin-finances) — prop `fetchers`, four states.
// ---------------------------------------------------------------------------

function financesDashboard() {
  return {
    spending: {
      windowDays: 30,
      fromDate: "2026-05-18",
      toDate: "2026-06-17",
      totalSpendUsd: 1234.5,
      totalIncomeUsd: 4000,
      netUsd: 2765.5,
      transactionCount: 12,
    },
    generatedAt: "2026-06-17T12:00:00.000Z",
  };
}

function financesSources(status: "active" | "disconnected" = "active") {
  return {
    sources: [
      {
        id: "src-1",
        kind: "plaid",
        label: "Checking",
        institution: "Acme Bank",
        status,
      },
    ],
  };
}

function financesTransactions() {
  return {
    transactions: [
      {
        id: "tx-1",
        postedAt: "2026-06-16T09:00:00.000Z",
        amountUsd: 42.5,
        direction: "debit",
        merchantDisplay: "Coffee Bar",
        merchantNormalized: "coffee-bar",
        merchantRaw: "COFFEE BAR #12",
        description: "Latte",
        category: "dining",
        currency: "USD",
      },
    ],
  };
}

function financesRecurring() {
  return {
    charges: [
      {
        merchantNormalized: "netflix",
        merchantDisplay: "Netflix",
        cadence: "monthly",
        averageAmountUsd: 15.99,
        nextExpectedAt: "2026-07-01T00:00:00.000Z",
        category: "entertainment",
      },
    ],
  };
}

function financesFetchers(sourceStatus: "active" | "disconnected") {
  return {
    fetchDashboard: async () => financesDashboard(),
    fetchSources: async () => financesSources(sourceStatus),
    fetchTransactions: async () => financesTransactions(),
    fetchRecurring: async () => financesRecurring(),
  };
}

const financesFixtures: Record<string, () => Record<string, unknown>> = {
  loading: () => ({
    fetchers: { ...financesFetchers("active"), fetchDashboard: NEVER },
  }),
  error: () => ({
    fetchers: { ...financesFetchers("active"), fetchDashboard: THROW },
  }),
  empty: () => ({ fetchers: financesFetchers("disconnected") }),
  populated: () => ({ fetchers: financesFetchers("active") }),
};

// ---------------------------------------------------------------------------
// Inbox (plugin-inbox) — prop `fetchers`, no test; derived from wire shape.
// ---------------------------------------------------------------------------

function inboxPopulated() {
  return {
    messages: [
      {
        id: "gmail-1",
        channel: "gmail",
        sender: {
          id: "s1",
          displayName: "Acme Billing",
          email: "billing@acme.com",
          avatarUrl: null,
        },
        subject: "Invoice #42",
        snippet: "Your invoice is ready to review and pay before the 30th.",
        receivedAt: "2026-06-16T09:00:00.000Z",
        unread: true,
        threadId: "t1",
      },
      {
        id: "discord-1",
        channel: "discord",
        sender: {
          id: "s2",
          displayName: "alice",
          email: null,
          avatarUrl: null,
        },
        subject: null,
        snippet: "ping me when free to talk about the launch",
        receivedAt: "2026-06-17T11:30:00.000Z",
        unread: false,
      },
    ],
    channelCounts: {
      gmail: { total: 1, unread: 1 },
      discord: { total: 1, unread: 0 },
    },
    fetchedAt: "2026-06-17T12:00:00.000Z",
    sources: [
      { source: "chat", state: "ok", degradations: [] },
      { source: "gmail", state: "ok", degradations: [] },
    ],
  };
}

/** Gmail auth expired: chat messages still flow, Gmail rides the banner. */
function inboxDegraded() {
  const populated = inboxPopulated();
  return {
    ...populated,
    messages: populated.messages.filter(
      (message) => message.channel !== "gmail",
    ),
    channelCounts: { discord: { total: 1, unread: 0 } },
    sources: [
      { source: "chat", state: "ok", degradations: [] },
      {
        source: "gmail",
        state: "degraded",
        degradations: [
          {
            axis: "auth-expired",
            code: "gmail_needs_reauth",
            message:
              "Gmail authorization has expired — reconnect Google to resume inbox sync.",
            retryable: false,
          },
        ],
      },
    ],
  };
}

const inboxFixtures: Record<string, () => Record<string, unknown>> = {
  loading: () => ({ fetchers: { fetchInbox: NEVER } }),
  error: () => ({ fetchers: { fetchInbox: THROW } }),
  empty: () => ({
    fetchers: {
      fetchInbox: async () => ({
        messages: [],
        channelCounts: {},
        fetchedAt: "2026-06-17T12:00:00.000Z",
        sources: [],
      }),
    },
  }),
  populated: () => ({ fetchers: { fetchInbox: async () => inboxPopulated() } }),
  degraded: () => ({ fetchers: { fetchInbox: async () => inboxDegraded() } }),
};

// ---------------------------------------------------------------------------
// Goals (plugin-goals) — prop `fetchers`, no test; derived from wire shape.
// ---------------------------------------------------------------------------

function goalsPopulated() {
  return {
    goals: [
      {
        goal: {
          id: "g1",
          title: "Ship E1 tape-out",
          description: "Close all signoff gates before the foundry window.",
          cadence: { kind: "weekly" },
          successCriteria: { targetText: "All gates green by Q3" },
          status: "active",
          reviewState: "at_risk",
          metadata: {},
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z",
        },
        links: [{ id: "l1", goalId: "g1", linkedType: "task", linkedId: "t1" }],
      },
      {
        goal: {
          id: "g2",
          title: "Run a half marathon",
          description: "Build base mileage, then a 12-week plan.",
          cadence: null,
          successCriteria: { target: "Finish under 2 hours" },
          status: "paused",
          reviewState: "idle",
          metadata: {},
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
        links: [],
      },
    ],
  };
}

const goalsFixtures: Record<string, () => Record<string, unknown>> = {
  loading: () => ({ fetchers: { fetchGoals: NEVER } }),
  error: () => ({ fetchers: { fetchGoals: THROW } }),
  empty: () => ({ fetchers: { fetchGoals: async () => ({ goals: [] }) } }),
  populated: () => ({ fetchers: { fetchGoals: async () => goalsPopulated() } }),
};

// ---------------------------------------------------------------------------
// Todos (plugin-todos) — prop `fetchers`, four states.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let todoSeq = 0;
function todo(overrides: Record<string, unknown>) {
  todoSeq += 1;
  return {
    id: `todo-${todoSeq}`,
    title: `Todo ${todoSeq}`,
    status: "pending",
    dueDate: null,
    ...overrides,
  };
}

function todosPopulated() {
  const now = Date.now();
  return {
    todos: [
      todo({
        title: "Overdue task",
        status: "pending",
        dueDate: new Date(now - HOUR).toISOString(),
      }),
      todo({
        title: "Due in two hours",
        status: "in_progress",
        dueDate: new Date(now + 2 * HOUR).toISOString(),
      }),
      todo({
        title: "Due in five days",
        status: "pending",
        dueDate: new Date(now + 5 * DAY).toISOString(),
      }),
      todo({ title: "No due date", status: "pending", dueDate: null }),
      todo({
        title: "Done task",
        status: "completed",
        dueDate: new Date(now - HOUR).toISOString(),
      }),
    ],
  };
}

const todosFixtures: Record<string, () => Record<string, unknown>> = {
  loading: () => ({ fetchers: { fetchTodos: NEVER } }),
  error: () => ({ fetchers: { fetchTodos: THROW } }),
  empty: () => ({ fetchers: { fetchTodos: async () => ({ todos: [] }) } }),
  populated: () => ({ fetchers: { fetchTodos: async () => todosPopulated() } }),
};

// ---------------------------------------------------------------------------
// Documents (plugin-documents) — prop `fetchers`, four states.
// ---------------------------------------------------------------------------

function presentedDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    filename: "Quarterly Plan.md",
    contentType: "text/markdown",
    fileSize: 4096,
    createdAt: Date.parse("2026-06-16T09:00:00.000Z"),
    fragmentCount: 7,
    source: "upload",
    scope: "global",
    provenance: { kind: "upload", label: "Manual upload" },
    canEditText: true,
    canDelete: true,
    ...overrides,
  };
}

function documentsList(documents = [presentedDocument()]) {
  return {
    ok: true,
    available: true,
    agentId: "agent-1",
    documents,
    total: documents.length,
    limit: 100,
    offset: 0,
  };
}

function documentsStats(count = 1) {
  return {
    documentCount: count,
    fragmentCount: count === 0 ? 0 : 7,
    agentId: "agent-1",
  };
}

const documentsFixtures: Record<string, () => Record<string, unknown>> = {
  loading: () => ({
    fetchers: {
      fetchDocuments: NEVER,
      fetchStats: async () => documentsStats(),
      fetchSearch: async (q: string) => ({
        query: q,
        threshold: 0.3,
        results: [],
        count: 0,
      }),
    },
  }),
  error: () => ({
    fetchers: {
      fetchDocuments: THROW,
      fetchStats: async () => documentsStats(),
      fetchSearch: async (q: string) => ({
        query: q,
        threshold: 0.3,
        results: [],
        count: 0,
      }),
    },
  }),
  empty: () => ({
    fetchers: {
      fetchDocuments: async () => documentsList([]),
      fetchStats: async () => documentsStats(0),
      fetchSearch: async (q: string) => ({
        query: q,
        threshold: 0.3,
        results: [],
        count: 0,
      }),
    },
  }),
  populated: () => ({
    fetchers: {
      fetchDocuments: async () => documentsList(),
      fetchStats: async () => documentsStats(),
      fetchSearch: async (q: string) => ({
        query: q,
        threshold: 0.3,
        results: [
          {
            id: "frag-1",
            text: "The quarterly plan covers hiring and runway.",
            similarity: 0.81,
            documentId: "doc-1",
            documentTitle: "Quarterly Plan.md",
            position: 0,
          },
        ],
        count: 1,
      }),
    },
  }),
};

// ---------------------------------------------------------------------------
// Relationships (plugin-relationships) — prop `fetchers`, four states.
// ---------------------------------------------------------------------------

function relEntity(overrides: {
  entityId?: string;
  type?: string;
  preferredName?: string;
  identities?: { platform: string; handle: string; verified?: boolean }[];
}) {
  return {
    entityId: overrides.entityId ?? "ent-1",
    type: overrides.type ?? "person",
    preferredName: overrides.preferredName ?? "Pat Doe",
    fullName: overrides.preferredName ?? "Pat Doe",
    identities: (overrides.identities ?? []).map((identity) => ({
      platform: identity.platform,
      handle: identity.handle,
      displayName: identity.handle,
      verified: identity.verified ?? false,
      confidence: 0.9,
    })),
  };
}

function relationshipsFetchers() {
  return {
    fetchEntities: async () => ({
      entities: [
        relEntity({ entityId: "self", type: "person", preferredName: "Owner" }),
        relEntity({
          entityId: "ent-pat",
          type: "person",
          preferredName: "Pat Doe",
          identities: [
            { platform: "discord", handle: "pat#1", verified: true },
          ],
        }),
        relEntity({
          entityId: "ent-acme",
          type: "organization",
          preferredName: "Acme Corp",
        }),
      ],
    }),
    fetchRelationships: async () => ({
      relationships: [
        {
          relationshipId: "rel-pat",
          fromEntityId: "self",
          toEntityId: "ent-pat",
          type: "colleague_of",
          metadata: { cadenceDays: 14 },
          state: { lastInteractionAt: "2026-06-10T00:00:00.000Z" },
        },
      ],
    }),
  };
}

const relationshipsFixtures: Record<string, () => Record<string, unknown>> = {
  loading: () => ({
    fetchers: { fetchEntities: NEVER, fetchRelationships: NEVER },
  }),
  error: () => ({
    fetchers: {
      fetchEntities: THROW,
      fetchRelationships: async () => ({ relationships: [] }),
    },
  }),
  empty: () => ({
    fetchers: {
      fetchEntities: async () => ({ entities: [] }),
      fetchRelationships: async () => ({ relationships: [] }),
    },
  }),
  populated: () => ({ fetchers: relationshipsFetchers() }),
};

// ---------------------------------------------------------------------------
// Calendar (plugin-calendar) — hook seam, driven via global. Four states.
// ---------------------------------------------------------------------------

function calEvent(over: { id: string } & Record<string, unknown>) {
  return {
    externalId: over.id,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title: "Untitled",
    description: "",
    location: "",
    status: "confirmed",
    startAt: "2026-06-15T15:00:00.000Z",
    endAt: "2026-06-15T16:00:00.000Z",
    isAllDay: false,
    timezone: null,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...over,
  };
}

const noopFn = () => {};
const asyncNoop = async () => {};

function calResult(over: Record<string, unknown> = {}) {
  return {
    events: [] as unknown[],
    loading: false,
    error: null as string | null,
    viewMode: "week",
    setViewMode: noopFn,
    baseDate: new Date("2026-06-15T12:00:00.000Z"),
    windowStart: new Date("2026-06-14T00:00:00.000Z"),
    windowEnd: new Date("2026-06-21T00:00:00.000Z"),
    refresh: asyncNoop,
    goToToday: noopFn,
    goPrevious: noopFn,
    goNext: noopFn,
    ...over,
  };
}

/** Calendar's seam is a hook, not a prop — these populate the global instead. */
const calendarCalendarStates: Record<string, () => Record<string, unknown>> = {
  loading: () => calResult({ loading: true, events: [] }),
  error: () => calResult({ error: "Calendar failed to load." }),
  empty: () => calResult({ events: [] }),
  populated: () =>
    calResult({
      events: [
        calEvent({
          id: "e1",
          title: "Design sync",
          location: "Room 4B",
          startAt: new Date(2026, 5, 15, 9, 0, 0).toISOString(),
          endAt: new Date(2026, 5, 15, 10, 0, 0).toISOString(),
        }),
        calEvent({
          id: "e2",
          title: "1:1 with Pat",
          location: "Coffee",
          startAt: new Date(2026, 5, 16, 14, 0, 0).toISOString(),
          endAt: new Date(2026, 5, 16, 14, 30, 0).toISOString(),
        }),
      ],
    }),
};

// ---------------------------------------------------------------------------
// Registry — view id → { states, propsFor(state), calendar? }.
// ---------------------------------------------------------------------------

export interface ViewSpec {
  /** Ordered state ids to capture. */
  states: string[];
  /** Build the props object for a given state. */
  propsFor: (state: string) => Record<string, unknown>;
  /** Calendar-only: result object to place on the global hook seam. */
  calendarResultFor?: (state: string) => Record<string, unknown>;
}

export const VIEW_SPECS: Record<string, ViewSpec> = {
  focus: {
    states: [
      "loading",
      "error",
      "unavailable",
      "permission",
      "empty",
      "active",
    ],
    propsFor: (s) => focusFixtures[s](),
  },
  health: {
    states: ["loading", "error", "empty", "populated"],
    propsFor: (s) => healthFixtures[s](),
  },
  finances: {
    states: ["loading", "error", "empty", "populated"],
    propsFor: (s) => financesFixtures[s](),
  },
  inbox: {
    states: ["loading", "error", "empty", "populated", "degraded"],
    propsFor: (s) => inboxFixtures[s](),
  },
  goals: {
    states: ["loading", "error", "empty", "populated"],
    propsFor: (s) => goalsFixtures[s](),
  },
  todos: {
    states: ["loading", "error", "empty", "populated"],
    propsFor: (s) => todosFixtures[s](),
  },
  documents: {
    states: ["loading", "error", "empty", "populated"],
    propsFor: (s) => documentsFixtures[s](),
  },
  relationships: {
    states: ["loading", "error", "empty", "populated"],
    propsFor: (s) => relationshipsFixtures[s](),
  },
  calendar: {
    states: ["loading", "error", "empty", "populated"],
    // CalendarView takes no props; its seam is the hook global.
    propsFor: () => ({}),
    calendarResultFor: (s) => calendarCalendarStates[s](),
  },
};

export const VIEW_IDS = Object.keys(VIEW_SPECS);
