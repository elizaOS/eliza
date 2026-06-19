// @vitest-environment jsdom

/**
 * Behavioral e2e for the Vector Browser GUI view (list mode + 2D tab + error
 * states + every interactive control).
 *
 * What is real vs mocked:
 *   - REAL: the parser/layout module @elizaos/ui/components/pages/vector-browser-utils
 *     (rowToMemory / parseEmbedding / parseContent / buildVectorGraph2DLayout /
 *     PAGE_SIZE / DIM_COLUMNS). The view's own state machine and rendering are
 *     exercised against the real parser over real-shaped query rows.
 *   - MOCKED: the @elizaos/ui glue subpaths the view imports (api client,
 *     layout/panel/skeleton/primitive wrappers, useApp/useAgentElement/
 *     useRenderGuard/getBootConfig, MemoryDetailPanel). The mocks are thin
 *     passthroughs; MemoryDetailPanel renders the populated fields the view is
 *     contractually expected to surface so detail assertions are meaningful.
 *
 * The mocked api `client.executeDatabaseQuery` branches on the SQL the view
 * actually emits (COUNT(*), information_schema.columns, the memories+embeddings
 * JOIN, the `unique` COUNT), returning real-shaped QueryResult rows — including
 * dim_768 pgvector ::text embeddings so the populated graph/stat/badge paths
 * (never reachable in the packages/app smoke fixture) are covered here.
 *
 * TUI / XR contract test: N/A. plugin-vector-browser declares a single `gui`
 * view (src/plugin.ts) and exposes no interact() capability, so there is no
 * terminal/XR surface to drive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Translation helper: resolve to defaultValue when given, else the key ─────
type TVars = Record<string, unknown> | undefined;
function translate(key: string, vars?: TVars): string {
  if (vars && typeof vars.defaultValue === "string") {
    let out = vars.defaultValue;
    for (const [k, v] of Object.entries(vars)) {
      if (k === "defaultValue") continue;
      out = out.replace(new RegExp(`{{${k}}}`, "g"), String(v));
    }
    return out;
  }
  return key;
}

// ── Query backend driven by SQL pattern ─────────────────────────────────────
type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
};

const DIM_COLS = [
  "dim_384",
  "dim_512",
  "dim_768",
  "dim_1024",
  "dim_1536",
  "dim_3072",
] as const;

function pgvector(dim: number, seed: number): string {
  const parts: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    parts.push(Number(((seed + 1) * 0.013 + i * 0.0007).toFixed(6)));
  }
  return `[${parts.join(",")}]`;
}

function memoryRow(opts: {
  id: string;
  text: string;
  type: string;
  withEmbedding: boolean;
  seed: number;
}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: opts.id,
    content: JSON.stringify({ text: opts.text }),
    type: opts.type,
    room_id: `room-${opts.seed}`,
    entity_id: `entity-${opts.seed}`,
    created_at: "2026-06-16T10:30:00.000Z",
    unique: true,
  };
  for (const col of DIM_COLS) {
    row[col] =
      col === "dim_768" && opts.withEmbedding ? pgvector(768, opts.seed) : null;
  }
  return row;
}

/** Configurable backend state per test. */
const backend = vi.hoisted(() => ({
  tables: [] as Array<{
    name: string;
    schema: string;
    rowCount: number;
    columns: unknown[];
  }>,
  total: 0,
  uniqueCount: 0,
  /** Returns the page of memory rows for the given offset + search term. */
  memoryRows: (
    _offset: number,
    _search: string,
  ): Record<string, unknown>[] => [],
  /** Rows returned for graph view (INNER JOIN). */
  graphRows: (): Record<string, unknown>[] => [],
  tablesError: null as Error | null,
  queryError: null as Error | null,
  calls: [] as string[],
}));

function table(name: string) {
  return { name, schema: "public", rowCount: backend.total, columns: [] };
}

function qr(rows: Record<string, unknown>[]): QueryResult {
  return {
    columns: rows.length ? Object.keys(rows[0]) : [],
    rows,
    rowCount: rows.length,
    durationMs: 1,
  };
}

const getDatabaseTables = vi.fn(async () => {
  if (backend.tablesError) throw backend.tablesError;
  return { tables: backend.tables };
});

const executeDatabaseQuery = vi.fn(
  async (sql: string): Promise<QueryResult> => {
    backend.calls.push(sql);
    if (backend.queryError) throw backend.queryError;

    if (/SELECT COUNT\(\*\) as cnt/i.test(sql) && /"unique"/i.test(sql)) {
      return qr([{ cnt: backend.uniqueCount }]);
    }
    if (/SELECT COUNT\(\*\) as cnt/i.test(sql)) {
      return qr([{ cnt: backend.total }]);
    }
    if (/information_schema\.columns/i.test(sql)) {
      return qr([
        { column_name: "id", data_type: "uuid" },
        { column_name: "content", data_type: "jsonb" },
      ]);
    }
    if (/INNER JOIN "embeddings"/i.test(sql)) {
      return qr(backend.graphRows());
    }
    // The list LEFT JOIN / plain SELECT path.
    const offsetMatch = sql.match(/OFFSET (\d+)/i);
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    const likeMatch = sql.match(/LIKE '%([^%]*)%'/i);
    const search = likeMatch ? likeMatch[1] : "";
    return qr(backend.memoryRows(offset, search));
  },
);

vi.mock("@elizaos/ui/api", () => ({
  client: { getDatabaseTables, executeDatabaseQuery },
}));

vi.mock("@elizaos/ui/state", () => ({
  useApp: () => ({ t: translate }),
}));

vi.mock("@elizaos/ui/hooks", () => ({
  useRenderGuard: () => {},
}));

vi.mock("@elizaos/ui/config", () => ({
  getBootConfig: () => ({
    companionVectorBrowser: {
      THREE: {},
      createVectorBrowserRenderer: async () => {
        throw new Error("no renderer in jsdom");
      },
    },
  }),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

// Thin passthrough layout / panel / skeleton.
vi.mock("@elizaos/ui/layouts", () => ({
  WorkspaceLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="workspace-layout">{children}</div>
  ),
}));

vi.mock("@elizaos/ui/components/composites/page-panel", () => ({
  PagePanel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-panel">{children}</div>
  ),
}));

vi.mock("@elizaos/ui/components/ui/skeleton-layouts", () => ({
  ListSkeleton: () => <div data-testid="list-skeleton" />,
}));

// Primitive shims — Button/Input render real DOM; Select mirrors the radix
// onValueChange contract via a native <select> so we can drive it in jsdom.
vi.mock("@elizaos/ui/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit";
  } & Record<string, unknown>) => {
    const {
      ref: _ref,
      agentProps: _ap,
      ...domProps
    } = rest as Record<string, unknown>;
    return (
      <button
        type={type ?? "button"}
        onClick={onClick}
        disabled={disabled}
        {...(domProps as Record<string, unknown>)}
      >
        {children}
      </button>
    );
  },
}));

vi.mock("@elizaos/ui/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    onKeyDown,
    placeholder,
    ...rest
  }: {
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    placeholder?: string;
  } & Record<string, unknown>) => {
    const {
      ref: _ref,
      agentProps: _ap,
      ...domProps
    } = rest as Record<string, unknown>;
    return (
      <input
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        {...(domProps as Record<string, unknown>)}
      />
    );
  },
}));

vi.mock("@elizaos/ui/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  }) => (
    <select
      data-testid="table-select"
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) => <option value={value}>{children}</option>,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

// Faithful MemoryDetailPanel: renders the populated fields the real panel shows.
vi.mock("@elizaos/ui/components/pages/MemoryDetailPanel", () => ({
  MemoryDetailPanel: ({
    memory,
  }: {
    memory: {
      id: string;
      content: string;
      type: string;
      roomId: string;
      entityId: string;
      embedding: number[] | null;
    } | null;
  }) => {
    if (!memory) {
      return <div data-testid="detail-empty">Select a memory...</div>;
    }
    return (
      <div data-testid="detail-panel">
        <div data-testid="detail-content">{memory.content || "(empty)"}</div>
        <div data-testid="detail-id">{memory.id}</div>
        <div data-testid="detail-type">{memory.type}</div>
        <div data-testid="detail-room">{memory.roomId}</div>
        <div data-testid="detail-entity">{memory.entityId}</div>
        {memory.embedding ? (
          <div data-testid="detail-embedding">
            len={memory.embedding.length} first=
            {memory.embedding[0].toFixed(6)}
          </div>
        ) : null}
      </div>
    );
  },
}));

const { render, screen, fireEvent, cleanup, waitFor, within } = await import(
  "@testing-library/react"
);
const { VectorBrowserView } = await import("../src/VectorBrowserView.tsx");

beforeEach(() => {
  backend.tables = [];
  backend.total = 0;
  backend.uniqueCount = 0;
  backend.memoryRows = () => [];
  backend.graphRows = () => [];
  backend.tablesError = null;
  backend.queryError = null;
  backend.calls = [];
  getDatabaseTables.mockClear();
  executeDatabaseQuery.mockClear();
});

afterEach(() => {
  cleanup();
});

// ── Fixtures ────────────────────────────────────────────────────────────────
function seedSingleTable(rows: Record<string, unknown>[], total = rows.length) {
  backend.tables = [table("memories"), table("embeddings")];
  backend.total = total;
  backend.uniqueCount = total;
  backend.memoryRows = () => rows;
  backend.graphRows = () => rows;
}

describe("VectorBrowserView — populated list", () => {
  it("renders memory rows with content, NNd embedding badge, and stats", async () => {
    seedSingleTable([
      memoryRow({
        id: "m-0",
        text: "user prefers tea",
        type: "fact",
        withEmbedding: true,
        seed: 0,
      }),
      memoryRow({
        id: "m-1",
        text: "meeting at noon",
        type: "message",
        withEmbedding: true,
        seed: 1,
      }),
    ]);

    render(<VectorBrowserView />);

    // populated content rows (real value, not just a heading)
    expect(await screen.findByText("user prefers tea")).toBeTruthy();
    expect(screen.getByText("meeting at noon")).toBeTruthy();

    // embedding badge shows the real parsed length (768D) — appears per row
    const badges = screen.getAllByText("768D");
    expect(badges.length).toBeGreaterThanOrEqual(2);

    // stats metrics: total (2), embed dimensions (768D), unique (2)
    await waitFor(() => {
      expect(screen.getByText("embed")).toBeTruthy();
    });
    // "2" appears for total + unique metric values
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the empty state when there are no records", async () => {
    backend.tables = [table("memories"), table("embeddings")];
    backend.total = 0;
    backend.memoryRows = () => [];
    render(<VectorBrowserView />);
    expect(
      await screen.findByText("No memory records detected in the database."),
    ).toBeTruthy();
  });

  it("falls back content to (empty) when content is blank", async () => {
    const blank = memoryRow({
      id: "m-blank",
      text: "",
      type: "",
      withEmbedding: false,
      seed: 9,
    });
    blank.content = "";
    seedSingleTable([blank]);
    render(<VectorBrowserView />);
    expect(await screen.findByText("(empty)")).toBeTruthy();
  });
});

describe("VectorBrowserView — search control", () => {
  it("Search button issues a LIKE query and resets to page 0", async () => {
    seedSingleTable([
      memoryRow({
        id: "m-0",
        text: "alpha note",
        type: "fact",
        withEmbedding: true,
        seed: 0,
      }),
    ]);
    backend.memoryRows = (_offset, search) =>
      !search || search === "alpha"
        ? [
            memoryRow({
              id: "m-0",
              text: "alpha note",
              type: "fact",
              withEmbedding: true,
              seed: 0,
            }),
          ]
        : [];

    render(<VectorBrowserView />);
    await screen.findByText("alpha note");

    const input = screen.getByPlaceholderText(
      "vectorbrowserview.SearchContent",
    );
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "common.search" }));

    await waitFor(() => {
      expect(backend.calls.some((c) => /LIKE '%alpha%'/.test(c))).toBe(true);
    });
    expect(await screen.findByText("alpha note")).toBeTruthy();
  });

  it("Enter key in the search input triggers the same search", async () => {
    seedSingleTable([
      memoryRow({
        id: "m-0",
        text: "beta note",
        type: "fact",
        withEmbedding: true,
        seed: 0,
      }),
    ]);
    render(<VectorBrowserView />);
    await screen.findByText("beta note");

    const input = screen.getByPlaceholderText(
      "vectorbrowserview.SearchContent",
    );
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(backend.calls.some((c) => /LIKE '%beta%'/.test(c))).toBe(true);
    });
  });

  it("shows the search-specific empty state when a search matches nothing", async () => {
    seedSingleTable([
      memoryRow({
        id: "m-0",
        text: "gamma",
        type: "fact",
        withEmbedding: true,
        seed: 0,
      }),
    ]);
    backend.memoryRows = (_offset, search) =>
      search
        ? []
        : [
            memoryRow({
              id: "m-0",
              text: "gamma",
              type: "fact",
              withEmbedding: true,
              seed: 0,
            }),
          ];

    render(<VectorBrowserView />);
    await screen.findByText("gamma");

    const input = screen.getByPlaceholderText(
      "vectorbrowserview.SearchContent",
    );
    fireEvent.change(input, { target: { value: "nomatch" } });
    fireEvent.click(screen.getByRole("button", { name: "common.search" }));

    expect(
      await screen.findByText("No records match your search query."),
    ).toBeTruthy();
  });
});

describe("VectorBrowserView — table select reset cascade", () => {
  it("switching table resets search/page and queries the new table", async () => {
    backend.tables = [
      table("memories"),
      table("documents"),
      table("embeddings"),
    ];
    backend.total = 1;
    backend.memoryRows = () => [
      memoryRow({
        id: "m-0",
        text: "in memories",
        type: "fact",
        withEmbedding: true,
        seed: 0,
      }),
    ];
    render(<VectorBrowserView />);
    await screen.findByText("in memories");

    // type a search first so we can prove it is reset
    const input = screen.getByPlaceholderText(
      "vectorbrowserview.SearchContent",
    );
    fireEvent.change(input, { target: { value: "stale" } });

    backend.calls = [];
    const select = screen.getByTestId("table-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "documents" } });

    await waitFor(() => {
      expect(backend.calls.some((c) => /FROM "documents"/.test(c))).toBe(true);
    });
    // search input was cleared by the reset cascade
    expect(
      (
        screen.getByPlaceholderText(
          "vectorbrowserview.SearchContent",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    // no query carried the stale LIKE term
    expect(backend.calls.some((c) => /LIKE '%stale%'/.test(c))).toBe(false);
  });
});

describe("VectorBrowserView — pagination", () => {
  it("renders Page 1 / N footer and Next issues an OFFSET=25 query", async () => {
    // 60 rows total => 3 pages; PAGE_SIZE is 25
    backend.tables = [table("memories"), table("embeddings")];
    backend.total = 60;
    backend.uniqueCount = 60;
    backend.memoryRows = (offset) => [
      memoryRow({
        id: `m-${offset}`,
        text: `row at offset ${offset}`,
        type: "fact",
        withEmbedding: true,
        seed: offset,
      }),
    ];

    render(<VectorBrowserView />);
    expect(await screen.findByText("row at offset 0")).toBeTruthy();

    // footer "Page 1 / 3"
    await waitFor(() => {
      expect(screen.getByText(/1 \/ 3/)).toBeTruthy();
    });

    const prev = screen.getByRole("button", { name: "common.prev" });
    const next = screen.getByRole("button", { name: "common.next" });
    expect((prev as HTMLButtonElement).disabled).toBe(true);
    expect((next as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(next);

    await waitFor(() => {
      expect(backend.calls.some((c) => /OFFSET 25/.test(c))).toBe(true);
    });
    expect(await screen.findByText("row at offset 25")).toBeTruthy();
    // now on page 2 of 3, prev becomes enabled
    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "common.prev",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
  });
});

describe("VectorBrowserView — detail face", () => {
  it("clicking a row opens the populated detail panel; Back returns to list", async () => {
    seedSingleTable([
      memoryRow({
        id: "mem-detail",
        text: "open me",
        type: "fact",
        withEmbedding: true,
        seed: 7,
      }),
      memoryRow({
        id: "mem-other",
        text: "another",
        type: "message",
        withEmbedding: true,
        seed: 8,
      }),
    ]);
    render(<VectorBrowserView />);
    const row = await screen.findByText("open me");

    fireEvent.click(row.closest("button") as HTMLButtonElement);

    const panel = await screen.findByTestId("detail-panel");
    const region = within(panel);
    expect(region.getByTestId("detail-content").textContent).toBe("open me");
    expect(region.getByTestId("detail-id").textContent).toBe("mem-detail");
    expect(region.getByTestId("detail-type").textContent).toBe("fact");
    expect(region.getByTestId("detail-room").textContent).toBe("room-7");
    expect(region.getByTestId("detail-entity").textContent).toBe("entity-7");
    // embedding length + first toFixed(6) value rendered
    expect(region.getByTestId("detail-embedding").textContent).toContain(
      "len=768",
    );
    expect(region.getByTestId("detail-embedding").textContent).toContain(
      "first=0.104000",
    );

    // Back to list returns to the master list
    fireEvent.click(screen.getByRole("button", { name: "← Back to list" }));
    expect(await screen.findByText("another")).toBeTruthy();
    expect(screen.queryByTestId("detail-panel")).toBeNull();
  });
});

describe("VectorBrowserView — 2D graph tab", () => {
  it("renders the populated projection header + canvas with >=2 embeddings", async () => {
    seedSingleTable([
      memoryRow({
        id: "m-0",
        text: "a",
        type: "fact",
        withEmbedding: true,
        seed: 0,
      }),
      memoryRow({
        id: "m-1",
        text: "b",
        type: "message",
        withEmbedding: true,
        seed: 1,
      }),
      memoryRow({
        id: "m-2",
        text: "c",
        type: "fact",
        withEmbedding: true,
        seed: 2,
      }),
    ]);
    const { container } = render(<VectorBrowserView />);
    await screen.findByText("a");

    fireEvent.click(screen.getByRole("button", { name: "2D" }));

    // aria-current marks the active tab
    await waitFor(() => {
      const tab = screen.getByRole("button", { name: "2D" });
      expect(tab.getAttribute("aria-current")).toBe("true");
    });
    // populated path: "N vectors projected to ..." header (NOT the empty state).
    // The header is "{N} {t('vectorbrowserview.vectorsProjectedTo')}"; the mock
    // t() renders the bare key, so match it.
    expect(
      await screen.findByText(/vectorbrowserview\.vectorsProjectedTo/),
    ).toBeTruthy();
    // the <2 empty-state key must NOT be present on the populated path
    expect(
      screen.queryByText("vectorbrowserview.NotEnoughEmbedding"),
    ).toBeNull();
    // a canvas is mounted for the 2D projection
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  it("renders the 'Not enough embeddings' state with <2 embeddings", async () => {
    backend.tables = [table("memories"), table("embeddings")];
    backend.total = 1;
    backend.graphRows = () => [
      memoryRow({
        id: "m-0",
        text: "lonely",
        type: "fact",
        withEmbedding: false,
        seed: 0,
      }),
    ];
    backend.memoryRows = () => [
      memoryRow({
        id: "m-0",
        text: "lonely",
        type: "fact",
        withEmbedding: false,
        seed: 0,
      }),
    ];
    render(<VectorBrowserView />);
    await screen.findByText("lonely");

    fireEvent.click(screen.getByRole("button", { name: "2D" }));
    // empty-state heading uses a bare i18n key (no defaultValue) -> mock t()
    // renders the key. This guards the smoke regression: <2 embeddings can only
    // ever show the empty state.
    expect(
      await screen.findByText("vectorbrowserview.NotEnoughEmbedding"),
    ).toBeTruthy();
  });
});

describe("VectorBrowserView — error states", () => {
  it("shows the connection-error screen and Retry re-invokes getDatabaseTables", async () => {
    backend.tablesError = new Error("Failed to fetch");
    render(<VectorBrowserView />);

    // The connection-error screen is gated on the error message containing
    // "agent is running" (the DatabaseConnectionError default). These headings
    // use bare i18n keys (no defaultValue), so the mock t() renders the key.
    expect(
      await screen.findByText("databaseview.DatabaseNotAvailab"),
    ).toBeTruthy();
    expect(screen.getByText("vectorbrowserview.StartTheAgentToB")).toBeTruthy();
    expect(getDatabaseTables).toHaveBeenCalledTimes(1);

    // Retry: clear the error and reload tables
    backend.tablesError = null;
    backend.tables = [table("memories"), table("embeddings")];
    backend.total = 1;
    backend.memoryRows = () => [
      memoryRow({
        id: "m-0",
        text: "recovered",
        type: "fact",
        withEmbedding: true,
        seed: 0,
      }),
    ];

    fireEvent.click(
      screen.getByRole("button", { name: "vectorbrowserview.RetryConnection" }),
    );

    await waitFor(() => {
      expect(getDatabaseTables.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(await screen.findByText("recovered")).toBeTruthy();
  });

  it("renders the LoadFailed error banner when a query fails", async () => {
    backend.tables = [table("memories"), table("embeddings")];
    backend.total = 1;
    backend.queryError = new Error("syntax error at or near SELECT");
    render(<VectorBrowserView />);

    expect(
      await screen.findByText(
        "Failed to load memories: syntax error at or near SELECT",
      ),
    ).toBeTruthy();
  });
});
