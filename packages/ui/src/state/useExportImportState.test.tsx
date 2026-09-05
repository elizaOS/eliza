// @vitest-environment jsdom

/**
 * Pins the agent-transfer (export/import) UI state contract in packages/ui.
 * The hook mirrors the server-enforced 12-char wire bound and owns the busy
 * locks, filename fallback, and import summary composition that AdvancedSection
 * renders. AdvancedSection.test.tsx mocks the whole state module, so this is
 * the only suite that executes the real hook.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exportAgentMock = vi.fn();
const importAgentMock = vi.fn();

vi.mock("../api", () => ({
  client: {
    exportAgent: (...args: unknown[]) => exportAgentMock(...args),
    importAgent: (...args: unknown[]) => importAgentMock(...args),
  },
}));

import { useExportImportState } from "./useExportImportState";

function mockExportResponse(
  disposition: string | null,
  blobSize = 2048,
): Response {
  const blob = new Blob(["x".repeat(blobSize)], {
    type: "application/octet-stream",
  });
  return {
    blob: vi.fn(async () => blob),
    headers: {
      get: (name: string) =>
        name === "Content-Disposition" ? disposition : null,
    },
  } as unknown as Response;
}

function createImportFile(content = "payload"): File {
  const blob = new Blob([content], { type: "application/octet-stream" });
  const file = new File([blob], "export.eliza-agent", {
    type: "application/octet-stream",
  });
  return file;
}

let capturedAnchors: HTMLAnchorElement[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  capturedAnchors = [];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(document.body, "appendChild").mockImplementation(((node: Node) => {
    if ((node as Element).tagName === "A") {
      capturedAnchors.push(node as HTMLAnchorElement);
    }
    return node as unknown as Node;
  }) as unknown as typeof document.body.appendChild);
  vi.spyOn(document.body, "removeChild").mockImplementation(((node: Node) => {
    return node as unknown as Node;
  }) as unknown as typeof document.body.removeChild);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useExportImportState", () => {
  it("export: requires password", async () => {
    const { result } = renderHook(() => useExportImportState());
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(result.current.state.exportError).toBe("Password is required.");
    expect(result.current.state.exportSuccess).toBeNull();
    expect(exportAgentMock).not.toHaveBeenCalled();
  });

  it("export: rejects short password (<12) and preserves message shape", async () => {
    const { result } = renderHook(() => useExportImportState());
    act(() => {
      result.current.setExportPassword("a".repeat(11));
    });
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(result.current.state.exportError).toBe(
      "Password must be at least 12 characters.",
    );
    expect(exportAgentMock).not.toHaveBeenCalled();
  });

  it("export: accepts 12-char password", async () => {
    const { result } = renderHook(() => useExportImportState());
    exportAgentMock.mockResolvedValueOnce(mockExportResponse(null));
    act(() => {
      result.current.setExportPassword("a".repeat(12));
    });
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(exportAgentMock).toHaveBeenCalledTimes(1);
    expect(exportAgentMock).toHaveBeenCalledWith("a".repeat(12), false);
    expect(result.current.state.exportError).toBeNull();
    expect(result.current.state.exportSuccess).toMatch(/Exported successfully/);
    expect(result.current.state.exportPassword).toBe("");
  });

  it("export: busy lock prevents duplicate submissions", async () => {
    const { result } = renderHook(() => useExportImportState());
    let resolveExport: (v: Response) => void = () => {};
    exportAgentMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveExport = resolve;
      }),
    );
    act(() => {
      result.current.setExportPassword("a".repeat(12));
    });
    let first: Promise<void> | undefined;
    await act(async () => {
      first = result.current.handleAgentExport();
    });
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(exportAgentMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveExport(mockExportResponse(null));
      await first;
    });
    expect(result.current.state.exportBusy).toBe(false);
  });

  it("export: parses quoted filename", async () => {
    const { result } = renderHook(() => useExportImportState());
    exportAgentMock.mockResolvedValueOnce(
      mockExportResponse('attachment; filename="quoted.eliza-agent"'),
    );
    act(() => result.current.setExportPassword("a".repeat(12)));
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(capturedAnchors[0]?.download).toBe("quoted.eliza-agent");
  });

  it("export: parses unquoted filename", async () => {
    const { result } = renderHook(() => useExportImportState());
    exportAgentMock.mockResolvedValueOnce(
      mockExportResponse("attachment; filename=unquoted.eliza-agent"),
    );
    act(() => result.current.setExportPassword("a".repeat(12)));
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(capturedAnchors[0]?.download).toBe("unquoted.eliza-agent");
  });

  it("export: falls back when Content-Disposition absent", async () => {
    const { result } = renderHook(() => useExportImportState());
    exportAgentMock.mockResolvedValueOnce(mockExportResponse(null));
    act(() => result.current.setExportPassword("a".repeat(12)));
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(capturedAnchors[0]?.download).toBe("agent-export.eliza-agent");
  });

  it("export: clears prior success on validation failure", async () => {
    const { result } = renderHook(() => useExportImportState());
    exportAgentMock.mockResolvedValueOnce(mockExportResponse(null));
    act(() => result.current.setExportPassword("a".repeat(12)));
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(result.current.state.exportSuccess).not.toBeNull();
    act(() => result.current.setExportPassword(""));
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(result.current.state.exportSuccess).toBeNull();
    expect(result.current.state.exportError).toBe("Password is required.");
  });

  it("import: requires file and password", async () => {
    const { result } = renderHook(() => useExportImportState());
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.importError).toBe(
      "Select an export file before importing.",
    );
    expect(importAgentMock).not.toHaveBeenCalled();
    const file = createImportFile();
    act(() => {
      result.current.setImportFile(file);
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.importError).toBe("Password is required.");
    expect(importAgentMock).not.toHaveBeenCalled();
  });

  it("import: rejects short password", async () => {
    const { result } = renderHook(() => useExportImportState());
    act(() => {
      result.current.setImportFile(createImportFile());
      result.current.setImportPassword("a".repeat(11));
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.importError).toBe(
      "Password must be at least 12 characters.",
    );
    expect(importAgentMock).not.toHaveBeenCalled();
  });

  it("import: busy lock prevents duplicate submissions", async () => {
    const { result } = renderHook(() => useExportImportState());
    let resolveImport: (v: unknown) => void = () => {};
    importAgentMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    act(() => {
      result.current.setImportFile(createImportFile());
      result.current.setImportPassword("a".repeat(12));
    });
    let first: Promise<void> | undefined;
    await act(async () => {
      first = result.current.handleAgentImport();
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(importAgentMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveImport({ agentName: "X", counts: { memories: 1 } });
      await first;
    });
    expect(result.current.state.importBusy).toBe(false);
  });

  it("import: composes summary with commas", async () => {
    const { result } = renderHook(() => useExportImportState());
    importAgentMock.mockResolvedValueOnce({
      agentName: "My Agent",
      counts: { memories: 2, entities: 3, rooms: 1 },
    });
    act(() => {
      result.current.setImportFile(createImportFile());
      result.current.setImportPassword("a".repeat(12));
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.importSuccess).toBe(
      'Imported "My Agent" successfully: 2 memories, 3 entities, 1 rooms. Restart the agent to activate.',
    );
    expect(result.current.state.importPassword).toBe("");
    expect(result.current.state.importFile).toBeNull();
  });

  it("import: omits zero counts and uses no-data fallback", async () => {
    const { result } = renderHook(() => useExportImportState());
    importAgentMock.mockResolvedValueOnce({
      agentName: "A",
      counts: { memories: 5, entities: 0, rooms: 0 },
    });
    act(() => {
      result.current.setImportFile(createImportFile());
      result.current.setImportPassword("a".repeat(12));
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.importSuccess).toBe(
      'Imported "A" successfully: 5 memories. Restart the agent to activate.',
    );
  });

  it("import: no-data when all zero", async () => {
    const { result } = renderHook(() => useExportImportState());
    importAgentMock.mockResolvedValueOnce({
      agentName: "B",
      counts: { memories: 0, entities: 0, rooms: 0 },
    });
    act(() => {
      result.current.setImportFile(createImportFile());
      result.current.setImportPassword("a".repeat(12));
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.importSuccess).toBe(
      'Imported "B" successfully: no data. Restart the agent to activate.',
    );
  });

  it("import: clears prior success on validation failure", async () => {
    const { result } = renderHook(() => useExportImportState());
    importAgentMock.mockResolvedValueOnce({
      agentName: "X",
      counts: { memories: 1 },
    });
    act(() => {
      result.current.setImportFile(createImportFile());
      result.current.setImportPassword("a".repeat(12));
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.importSuccess).not.toBeNull();
    act(() => {
      result.current.setImportPassword("");
      result.current.setImportFile(createImportFile());
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.importSuccess).toBeNull();
  });

  it("import and export errors are isolated", async () => {
    const { result } = renderHook(() => useExportImportState());
    act(() => result.current.setExportPassword("a".repeat(11)));
    await act(async () => {
      await result.current.handleAgentExport();
    });
    expect(result.current.state.importError).toBeNull();
    act(() => {
      result.current.setImportFile(createImportFile());
      result.current.setImportPassword("a".repeat(11));
    });
    await act(async () => {
      await result.current.handleAgentImport();
    });
    expect(result.current.state.exportError).toBe(
      "Password must be at least 12 characters.",
    );
  });
});
