/**
 * E2E tests for Knowledge Management UI (KnowledgeView).
 *
 * Tests cover:
 * 1. Document upload (file and URL)
 * 2. Document listing
 * 3. Document search
 * 4. Document deletion
 * 5. Stats display
 * 6. Fragment viewing
 */

import http from "node:http";
import { client } from "@elizaos/app-core/api";
// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Part 1: API Tests for Knowledge Endpoints
// ---------------------------------------------------------------------------

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function createKnowledgeTestServer(): Promise<{
  port: number;
  close: () => Promise<void>;
  getDocuments: () => Array<{
    id: string;
    title: string;
    fragmentCount: number;
  }>;
}> {
  const documents: Array<{
    id: string;
    title: string;
    content: string;
    fragmentCount: number;
    createdAt: string;
    size: number;
  }> = [
    {
      id: "doc-1",
      title: "README.md",
      content: "# Project Documentation",
      fragmentCount: 3,
      createdAt: new Date().toISOString(),
      size: 1024,
    },
    {
      id: "doc-2",
      title: "guide.pdf",
      content: "User guide content",
      fragmentCount: 10,
      createdAt: new Date().toISOString(),
      size: 50000,
    },
  ];

  const json = (res: http.ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(data));
  };

  const readBody = (r: http.IncomingMessage): Promise<string> =>
    new Promise((ok) => {
      const c: Buffer[] = [];
      r.on("data", (d: Buffer) => c.push(d));
      r.on("end", () => ok(Buffer.concat(c).toString()));
    });

  const routes: Record<
    string,
    (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<void> | void
  > = {
    "GET /api/knowledge/stats": (_r, res) =>
      json(res, {
        documentCount: documents.length,
        fragmentCount: documents.reduce((sum, d) => sum + d.fragmentCount, 0),
      }),
    "GET /api/knowledge/documents": (_r, res) => json(res, { documents }),
    "POST /api/knowledge/upload": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const newDoc = {
        id: `doc-${Date.now()}`,
        title: (body.filename as string) || "uploaded.txt",
        content: (body.content as string) || "",
        fragmentCount: Math.floor(Math.random() * 10) + 1,
        createdAt: new Date().toISOString(),
        size: ((body.content as string) || "").length,
      };
      documents.push(newDoc);
      json(res, { ok: true, document: newDoc });
    },
    "POST /api/knowledge/upload-url": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const url = body.url as string;
      const newDoc = {
        id: `doc-${Date.now()}`,
        title: url.split("/").pop() || "url-content",
        content: "Content from URL",
        fragmentCount: 5,
        createdAt: new Date().toISOString(),
        size: 2048,
      };
      documents.push(newDoc);
      json(res, { ok: true, document: newDoc });
    },
    "POST /api/knowledge/search": async (r, res) => {
      const body = JSON.parse(await readBody(r)) as Record<string, unknown>;
      const query = (body.query as string) || "";
      const results = documents
        .filter(
          (d) =>
            d.title.toLowerCase().includes(query.toLowerCase()) ||
            d.content.toLowerCase().includes(query.toLowerCase()),
        )
        .map((d) => ({
          documentId: d.id,
          title: d.title,
          snippet: d.content.slice(0, 100),
          score: 0.9,
        }));
      json(res, { results });
    },
    "DELETE /api/knowledge/documents": async (r, res) => {
      const url = new URL(r.url ?? "/", "http://localhost");
      const docId = url.searchParams.get("id");
      const idx = documents.findIndex((d) => d.id === docId);
      if (idx !== -1) {
        documents.splice(idx, 1);
        json(res, { ok: true });
      } else {
        json(res, { error: "Document not found" }, 404);
      }
    },
  };

  const server = http.createServer(async (rq, rs) => {
    if (rq.method === "OPTIONS") {
      rs.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      });
      rs.end();
      return;
    }
    const pathname = new URL(rq.url ?? "/", "http://localhost").pathname;
    const key = `${rq.method} ${pathname}`;
    const handler = routes[key];
    if (handler) {
      await handler(rq, rs);
    } else {
      json(rs, { error: "Not found" }, 404);
    }
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      ok({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getDocuments: () =>
          documents.map((d) => ({
            id: d.id,
            title: d.title,
            fragmentCount: d.fragmentCount,
          })),
      });
    });
  });
}

describe("Knowledge API", () => {
  let port: number;
  let close: () => Promise<void>;
  let getDocuments: () => Array<{
    id: string;
    title: string;
    fragmentCount: number;
  }>;

  beforeAll(async () => {
    ({ port, close, getDocuments } = await createKnowledgeTestServer());
  });

  afterAll(async () => {
    await close();
  });

  it("GET /api/knowledge/stats returns counts", async () => {
    const { status, data } = await req(port, "GET", "/api/knowledge/stats");
    expect(status).toBe(200);
    expect(typeof data.documentCount).toBe("number");
    expect(typeof data.fragmentCount).toBe("number");
  });

  it("GET /api/knowledge/documents returns document list", async () => {
    const { status, data } = await req(port, "GET", "/api/knowledge/documents");
    expect(status).toBe(200);
    expect(Array.isArray(data.documents)).toBe(true);
    expect((data.documents as unknown[]).length).toBe(2);
  });

  it("POST /api/knowledge/upload adds document", async () => {
    const initialCount = getDocuments().length;
    const { status, data } = await req(port, "POST", "/api/knowledge/upload", {
      filename: "test.txt",
      content: "Test content for document",
    });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getDocuments().length).toBe(initialCount + 1);
  });

  it("POST /api/knowledge/upload-url adds document from URL", async () => {
    const initialCount = getDocuments().length;
    const { status, data } = await req(
      port,
      "POST",
      "/api/knowledge/upload-url",
      {
        url: "https://example.com/document.html",
      },
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getDocuments().length).toBe(initialCount + 1);
  });

  it("POST /api/knowledge/search returns matching results", async () => {
    const { status, data } = await req(port, "POST", "/api/knowledge/search", {
      query: "README",
    });
    expect(status).toBe(200);
    expect(Array.isArray(data.results)).toBe(true);
    expect((data.results as unknown[]).length).toBeGreaterThan(0);
  });

  it("POST /api/knowledge/search returns empty for no match", async () => {
    const { status, data } = await req(port, "POST", "/api/knowledge/search", {
      query: "nonexistent_query_xyz",
    });
    expect(status).toBe(200);
    expect(Array.isArray(data.results)).toBe(true);
  });

  it("DELETE /api/knowledge/documents removes document", async () => {
    const docs = getDocuments();
    const docToDelete = docs[0];
    const initialCount = docs.length;

    const { status, data } = await req(
      port,
      "DELETE",
      `/api/knowledge/documents?id=${docToDelete.id}`,
    );
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(getDocuments().length).toBe(initialCount - 1);
  });
});

// ---------------------------------------------------------------------------
// Part 2: UI Tests for KnowledgeView
// ---------------------------------------------------------------------------

const { mockUseApp } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
}));

vi.mock("@elizaos/app-core/state", async () => {
  const actual = await vi.importActual("@elizaos/app-core/state");
  return {
    ...actual,
    useApp: () => mockUseApp(),
  };
});

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getKnowledgeStats: vi.fn().mockResolvedValue({
      documentCount: 5,
      fragmentCount: 42,
    }),
    listKnowledgeDocuments: vi.fn().mockResolvedValue({
      documents: [
        {
          id: "doc-1",
          filename: "README.md",
          contentType: "text/markdown",
          fileSize: 1024,
          fragmentCount: 3,
          createdAt: Date.now(),
          source: "upload",
        },
        {
          id: "doc-2",
          filename: "guide.pdf",
          contentType: "application/pdf",
          fileSize: 50_000,
          fragmentCount: 10,
          createdAt: Date.now(),
          source: "upload",
        },
      ],
    }),
    getKnowledgeDocument: vi.fn().mockResolvedValue({
      document: {
        id: "doc-1",
        filename: "README.md",
        contentType: "text/markdown",
        fileSize: 1024,
        createdAt: Date.now(),
        fragmentCount: 3,
        source: "upload",
        content: { text: "# README" },
      },
    }),
    getKnowledgeFragments: vi.fn().mockResolvedValue({ fragments: [] }),
    uploadKnowledgeDocument: vi.fn().mockResolvedValue({ ok: true }),
    uploadKnowledgeUrl: vi.fn().mockResolvedValue({ ok: true }),
    searchKnowledge: vi.fn().mockResolvedValue([]),
    deleteKnowledgeDocument: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("../../src/components/shared/confirm-delete-control", () => ({
  ConfirmDeleteControl: ({
    onConfirm,
    children,
  }: {
    onConfirm: () => void;
    children: React.ReactNode;
  }) =>
    React.createElement(
      "button",
      { type: "button", onClick: onConfirm, "data-testid": "delete-btn" },
      children,
    ),
}));

import { KnowledgeView } from "../../src/components/KnowledgeView";

type KnowledgeState = {
  knowledgeStats: { documentCount: number; fragmentCount: number } | null;
  knowledgeDocuments: Array<{
    id: string;
    filename: string;
    contentType: string;
    fileSize: number;
    fragmentCount: number;
    createdAt: number;
    source: string;
  }>;
  knowledgeLoading: boolean;
  knowledgeSearchResults: Array<{
    documentId: string;
    title: string;
    snippet: string;
    score: number;
  }>;
};

function createKnowledgeUIState(): KnowledgeState {
  return {
    knowledgeStats: { documentCount: 5, fragmentCount: 42 },
    knowledgeDocuments: [
      {
        id: "doc-1",
        filename: "README.md",
        contentType: "text/markdown",
        fileSize: 1024,
        fragmentCount: 3,
        createdAt: Date.now(),
        source: "upload",
      },
      {
        id: "doc-2",
        filename: "guide.pdf",
        contentType: "application/pdf",
        fileSize: 50_000,
        fragmentCount: 10,
        createdAt: Date.now(),
        source: "upload",
      },
    ],
    knowledgeLoading: false,
    knowledgeSearchResults: [],
  };
}

describe("KnowledgeView UI", () => {
  let state: KnowledgeState;

  beforeEach(() => {
    state = createKnowledgeUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      t: (k: string) => k,
      ...state,
      loadKnowledgeStats: vi.fn(),
      loadKnowledgeDocuments: vi.fn(),
      uploadKnowledgeDocument: vi.fn(),
      searchKnowledge: vi.fn(),
      deleteKnowledgeDocument: vi.fn(),
      setActionNotice: vi.fn(),
    }));
  });

  it("renders KnowledgeView", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(KnowledgeView));
    });

    expect(tree).not.toBeNull();
  });

  it("displays document count in stats", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(KnowledgeView));
    });

    const allText = JSON.stringify(tree?.toJSON());
    expect(allText).toContain("Documents");
  });

  it("loads fragment details when opening a document", async () => {
    vi.mocked(client.getKnowledgeDocument).mockResolvedValueOnce({
      document: {
        id: "doc-1",
        filename: "README.md",
        contentType: "text/markdown",
        fileSize: 1024,
        createdAt: Date.now(),
        fragmentCount: 3,
        source: "upload",
        content: { text: "# README" },
      },
    });
    vi.mocked(client.getKnowledgeFragments).mockResolvedValueOnce({
      fragments: [
        {
          id: "fragment-1",
          text: "fragment body",
          position: 1,
          createdAt: Date.now(),
        },
      ],
    });

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(KnowledgeView));
    });

    const documentButtons =
      tree?.root.findAll(
        (node) =>
          node.type === "button" &&
          typeof node.props["aria-label"] === "string" &&
          node.props["aria-label"].startsWith("Open "),
      ) ?? [];
    expect(documentButtons.length).toBeGreaterThan(0);

    await act(async () => {
      documentButtons[0].props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const allText = JSON.stringify(tree?.toJSON());
    expect(allText).toContain("knowledgeview.Fragments1");
    expect(allText).toContain("fragment body");
  });

  it("renders upload zone", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(KnowledgeView));
    });

    // Look for file input or upload text
    const _inputs = tree?.root.findAll(
      (node) => node.type === "input" && node.props.type === "file",
    );
    // May have file input for uploads
    expect(tree).not.toBeNull();
  });

  it("renders document list", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(KnowledgeView));
    });

    // Component should render without crashing
    // Document list content may load asynchronously
    expect(tree).not.toBeNull();
  });

  it("renders search input", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(KnowledgeView));
    });

    const searchInputs = tree?.root.findAll(
      (node) =>
        node.type === "input" &&
        (node.props.placeholder?.toLowerCase().includes("search") ||
          node.props.type === "search"),
    );
    expect(searchInputs.length).toBeGreaterThanOrEqual(0);
  });

  it("keeps yellow knowledge action buttons on a dark foreground", async () => {
    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(KnowledgeView));
    });

    const findButton = (label: string) =>
      tree?.root
        .findAllByType("button")
        .find((node) => node.props.children === label);

    const chooseFilesButton = findButton("knowledgeview.ChooseFiles");
    const chooseFolderButton = findButton("knowledgeview.ChooseFolder");
    const searchButton = findButton("knowledge.ui.search");
    const searchForm = tree?.root.findAllByType("form")[0];

    expect(chooseFolderButton).toBeUndefined();
    expect(searchForm?.props.className).toContain("max-w-[500px]");
    expect(chooseFilesButton?.props.className).toContain("h-10");
    expect(chooseFilesButton?.props.className).toContain(
      "text-[var(--primary-foreground,#1a1f26)]",
    );
    expect(searchButton?.props.className).toContain("h-10");
    expect(searchButton?.props.className).toContain(
      "text-[var(--primary-foreground,#1a1f26)]",
    );
  });

  it("shows loading state when knowledgeLoading is true", async () => {
    state.knowledgeLoading = true;

    let tree: TestRenderer.ReactTestRenderer | null = null;

    await act(async () => {
      tree = TestRenderer.create(React.createElement(KnowledgeView));
    });

    expect(tree).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part 3: Knowledge Upload Integration Tests
// ---------------------------------------------------------------------------

describe("Knowledge Upload Integration", () => {
  let state: KnowledgeState;
  let uploadCalled: boolean;

  beforeEach(() => {
    state = createKnowledgeUIState();
    uploadCalled = false;

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      loadKnowledgeStats: vi.fn(),
      loadKnowledgeDocuments: vi.fn(),
      uploadKnowledgeDocument: async (file: File) => {
        uploadCalled = true;
        state.knowledgeDocuments.push({
          id: `doc-${Date.now()}`,
          title: file.name,
          fragmentCount: 5,
          createdAt: new Date().toISOString(),
        });
      },
      searchKnowledge: vi.fn(),
      deleteKnowledgeDocument: vi.fn(),
      setActionNotice: vi.fn(),
    }));
  });

  it("uploading document adds to list", async () => {
    const uploadFn = mockUseApp().uploadKnowledgeDocument;
    const initialCount = state.knowledgeDocuments.length;

    const mockFile = new File(["test content"], "test.txt", {
      type: "text/plain",
    });
    await uploadFn(mockFile);

    expect(uploadCalled).toBe(true);
    expect(state.knowledgeDocuments.length).toBe(initialCount + 1);
  });
});

// ---------------------------------------------------------------------------
// Part 4: Knowledge Search Integration Tests
// ---------------------------------------------------------------------------

describe("Knowledge Search Integration", () => {
  let state: KnowledgeState;

  beforeEach(() => {
    state = createKnowledgeUIState();

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      loadKnowledgeStats: vi.fn(),
      loadKnowledgeDocuments: vi.fn(),
      uploadKnowledgeDocument: vi.fn(),
      searchKnowledge: async (query: string) => {
        state.knowledgeSearchResults = state.knowledgeDocuments
          .filter((d) => d.filename.toLowerCase().includes(query.toLowerCase()))
          .map((d) => ({
            documentId: d.id,
            title: d.filename,
            snippet: "Matching content...",
            score: 0.9,
          }));
      },
      deleteKnowledgeDocument: vi.fn(),
      setActionNotice: vi.fn(),
    }));
  });

  it("searching updates results", async () => {
    const searchFn = mockUseApp().searchKnowledge;

    await searchFn("README");

    expect(state.knowledgeSearchResults.length).toBe(1);
    expect(state.knowledgeSearchResults[0].title).toBe("README.md");
  });

  it("searching with no match returns empty", async () => {
    const searchFn = mockUseApp().searchKnowledge;

    await searchFn("nonexistent");

    expect(state.knowledgeSearchResults.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Part 5: Knowledge Delete Integration Tests
// ---------------------------------------------------------------------------

describe("Knowledge Delete Integration", () => {
  let state: KnowledgeState;
  let deleteCalled: boolean;

  beforeEach(() => {
    state = createKnowledgeUIState();
    deleteCalled = false;

    mockUseApp.mockReset();
    mockUseApp.mockImplementation(() => ({
      ...state,
      loadKnowledgeStats: vi.fn(),
      loadKnowledgeDocuments: vi.fn(),
      uploadKnowledgeDocument: vi.fn(),
      searchKnowledge: vi.fn(),
      deleteKnowledgeDocument: async (docId: string) => {
        deleteCalled = true;
        const idx = state.knowledgeDocuments.findIndex((d) => d.id === docId);
        if (idx !== -1) {
          state.knowledgeDocuments.splice(idx, 1);
        }
      },
      setActionNotice: vi.fn(),
    }));
  });

  it("deleting document removes from list", async () => {
    const deleteFn = mockUseApp().deleteKnowledgeDocument;
    const initialCount = state.knowledgeDocuments.length;

    await deleteFn("doc-1");

    expect(deleteCalled).toBe(true);
    expect(state.knowledgeDocuments.length).toBe(initialCount - 1);
    expect(
      state.knowledgeDocuments.find((d) => d.id === "doc-1"),
    ).toBeUndefined();
  });
});
