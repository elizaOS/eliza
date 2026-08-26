/**
 * Component coverage for Knowledge availability states on web and native
 * mobile when the documents route is absent. The harness uses the real
 * DocumentsView state machine with only its transport and app context mocked.
 */
// @vitest-environment jsdom

import { ApiError } from "@elizaos/ui/api/client-types-core";
import {
  __resetResourceCache,
  getCached,
} from "@elizaos/ui/hooks/resource-cache";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const platformMock = vi.hoisted(() => ({ isNative: false }));
const authorityMock = vi.hoisted(() => ({ value: "agent-a" }));
const documentViewerMock = vi.hoisted(() => vi.fn());
const clientMock = vi.hoisted(() => ({
  getDocumentFacetCounts: vi.fn(),
  listDocuments: vi.fn(),
}));

vi.mock("@elizaos/ui/state", () => ({
  useAppSelector: (selector: (value: Record<string, unknown>) => unknown) =>
    selector(appMock.value),
  useTranslation: () => ({ t: appMock.value.t }),
  useRegisterViewChatBinding: () => {},
}));
vi.mock("@elizaos/ui/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/ui/api/client")>()),
  client: clientMock,
}));
vi.mock("@elizaos/ui/platform", () => ({
  get isNative() {
    return platformMock.isNative;
  },
}));
vi.mock("@elizaos/ui/hooks/useActiveAgentAuthority", () => ({
  useActiveAgentAuthority: () => authorityMock.value,
}));
vi.mock("./documents-detail", () => ({
  DocumentViewer: ({ documentId }: { documentId: string | null }) => {
    documentViewerMock({
      authority: authorityMock.value,
      documentId,
    });
    return <div data-testid="document-viewer">{documentId}</div>;
  },
}));

import { KnowledgeDocumentsView } from "./KnowledgeDocumentsView";

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function missingDocumentsRoute(): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/documents",
    message: "Not Found",
    status: 404,
  });
}

function sharedDocumentsRuntimeUnavailable(): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/documents",
    message:
      "Knowledge documents require a dedicated agent runtime; this shared agent does not have a document ingest store.",
    status: 503,
    code: "documents_runtime_unavailable",
    data: {
      success: false,
      code: "documents_runtime_unavailable",
      retryable: false,
    },
  });
}

beforeEach(() => {
  __resetResourceCache();
  platformMock.isNative = false;
  authorityMock.value = "agent-a";
  documentViewerMock.mockReset();
  appMock.value = { t, setActionNotice: vi.fn() };
  clientMock.listDocuments.mockReset();
  clientMock.getDocumentFacetCounts.mockReset();
  clientMock.listDocuments.mockRejectedValue(missingDocumentsRoute());
  clientMock.getDocumentFacetCounts.mockRejectedValue(missingDocumentsRoute());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("KnowledgeDocumentsView availability", () => {
  it("recovers when the documents route appears during deferred startup", async () => {
    vi.useFakeTimers();
    clientMock.listDocuments
      .mockRejectedValueOnce(missingDocumentsRoute())
      .mockResolvedValue({ documents: [] });
    clientMock.getDocumentFacetCounts.mockResolvedValue({
      counts: {
        all: 0,
        doc: 0,
        image: 0,
        audio: 0,
        video: 0,
        transcript: 0,
      },
    });

    render(<KnowledgeDocumentsView fileInputId="knowledge-upload" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(clientMock.listDocuments).toHaveBeenCalledTimes(2);
    expect(screen.getByText("No knowledge yet")).toBeTruthy();
    expect(
      screen.queryByText("This agent doesn't expose a Knowledge library yet."),
    ).toBeNull();
  });

  it("shows a calm capability error on web without empty-state CTAs", async () => {
    vi.useFakeTimers();
    render(<KnowledgeDocumentsView fileInputId="knowledge-upload" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(
      screen.getByText("This agent doesn't expose a Knowledge library yet."),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Knowledge isn't available on this device/i),
    ).toBeNull();
    expect(screen.queryByText("No knowledge yet")).toBeNull();
    expect(screen.queryByTestId("knowledge-add")).toBeNull();
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(appMock.value.setActionNotice).not.toHaveBeenCalled();
  });

  it("keeps the device-unavailable state for native mobile only", async () => {
    platformMock.isNative = true;
    render(<KnowledgeDocumentsView fileInputId="knowledge-upload" />);

    expect(
      await screen.findByText("Open the web or desktop app to manage it."),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("No knowledge yet")).toBeNull();
      expect(screen.queryByTestId("knowledge-add")).toBeNull();
    });
    expect(
      screen.queryByText("This agent doesn't expose a Knowledge library yet."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });

  it("shows an honest Shared-runtime capability state without retrying", async () => {
    clientMock.listDocuments.mockRejectedValue(
      sharedDocumentsRuntimeUnavailable(),
    );
    clientMock.getDocumentFacetCounts.mockRejectedValue(
      sharedDocumentsRuntimeUnavailable(),
    );

    render(<KnowledgeDocumentsView fileInputId="knowledge-upload" />);

    expect(
      await screen.findByText("Knowledge needs a Dedicated agent"),
    ).toBeTruthy();
    expect(
      screen.getByText("Connect a Dedicated agent to add and search files."),
    ).toBeTruthy();
    expect(screen.queryByText("No knowledge yet")).toBeNull();
    expect(screen.queryByTestId("knowledge-add")).toBeNull();
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });

  it("cancels agent-A warm-up before loading and caching agent B", async () => {
    vi.useFakeTimers();
    const requestedAuthorities: string[] = [];
    const agentBDocument = {
      id: "doc-b",
      filename: "agent-b-notes.txt",
      contentType: "text/plain",
      fileSize: 24,
      createdAt: 2,
      fragmentCount: 1,
      source: "upload",
      scope: "global",
      canEditText: true,
      canDelete: true,
    };
    clientMock.listDocuments.mockImplementation(() => {
      requestedAuthorities.push(authorityMock.value);
      if (authorityMock.value === "agent-a") {
        return Promise.reject(missingDocumentsRoute());
      }
      return Promise.resolve({ documents: [agentBDocument] });
    });
    clientMock.getDocumentFacetCounts.mockResolvedValue({
      counts: {
        all: 1,
        doc: 1,
        image: 0,
        audio: 0,
        video: 0,
        transcript: 0,
      },
    });

    const rendered = render(<KnowledgeDocumentsView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(requestedAuthorities).toEqual(["agent-a"]);

    authorityMock.value = "agent-b";
    rendered.rerender(<KnowledgeDocumentsView />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(requestedAuthorities).toEqual(["agent-a", "agent-b"]);
    expect(getCached("documents:agent-a:list:all:all")).toBeUndefined();
    expect(getCached("documents:agent-b:list:all:all")?.data).toEqual([
      agentBDocument,
    ]);
    expect(screen.getByText("agent-b-notes.txt")).toBeTruthy();
  });

  it("does not carry an agent-A reader selection into a deferred agent-B list", async () => {
    const agentADocument = {
      id: "doc-a",
      filename: "agent-a-private.txt",
      contentType: "text/plain",
      fileSize: 24,
      createdAt: 1,
      fragmentCount: 1,
      source: "upload",
      scope: "global",
      canEditText: true,
      canDelete: true,
    };
    clientMock.listDocuments.mockImplementation(() =>
      authorityMock.value === "agent-a"
        ? Promise.resolve({ documents: [agentADocument] })
        : new Promise(() => undefined),
    );
    clientMock.getDocumentFacetCounts.mockResolvedValue({
      counts: {
        all: 1,
        doc: 1,
        image: 0,
        audio: 0,
        video: 0,
        transcript: 0,
      },
    });

    const rendered = render(<KnowledgeDocumentsView />);
    fireEvent.click(await screen.findByText("agent-a-private.txt"));
    await waitFor(() =>
      expect(documentViewerMock).toHaveBeenCalledWith({
        authority: "agent-a",
        documentId: "doc-a",
      }),
    );
    documentViewerMock.mockClear();

    authorityMock.value = "agent-b";
    rendered.rerender(<KnowledgeDocumentsView />);
    await act(async () => undefined);

    expect(documentViewerMock).not.toHaveBeenCalledWith({
      authority: "agent-b",
      documentId: "doc-a",
    });
    expect(screen.queryByText("agent-a-private.txt")).toBeNull();
  });
});
