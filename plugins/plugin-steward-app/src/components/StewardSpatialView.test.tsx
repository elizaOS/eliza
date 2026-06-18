import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type StewardSnapshot,
  StewardSpatialView,
} from "./StewardSpatialView.tsx";

const approvalsSnapshot: StewardSnapshot = {
  tab: "approvals",
  connected: true,
  configured: true,
  available: true,
  evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
  pendingApprovals: [
    {
      queueId: "queue-1",
      requestedAt: "2026-05-18T12:00:00.000Z",
      txId: "tx-1",
      status: "pending",
      chainId: 8453,
      to: "0xfeed000000000000000000000000000000000000",
      value: "1000000000000000000",
      policyCount: 1,
    },
  ],
  history: [],
  historyTotal: 1,
  statusFilter: null,
  chainFilter: null,
  page: 0,
  pageSize: 25,
};

const historySnapshot: StewardSnapshot = {
  ...approvalsSnapshot,
  tab: "history",
  pendingApprovals: [],
  history: [
    {
      id: "tx-1",
      createdAt: "2026-05-18T12:00:00.000Z",
      status: "confirmed",
      chainId: 8453,
      to: "0xfeed000000000000000000000000000000000000",
      txHash: "0xhash000000000000000000000000000000000000",
      value: "1000000000000000000",
    },
  ],
  historyTotal: 30,
};

const approvalsView = <StewardSpatialView snapshot={approvalsSnapshot} />;
const historyView = <StewardSpatialView snapshot={historySnapshot} />;

describe("StewardSpatialView one source, three modalities", () => {
  it("TUI: renders the approvals tab honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(approvalsView, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Steward");
      expect(flat).toContain("connected");
      expect(flat).toContain("tx-1");
      expect(flat).toContain("Approve");
      expect(flat).toContain("Reject");
    }
  });

  it("TUI: renders the history tab honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(historyView, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Steward");
      expect(flat).toContain("tx-1");
      expect(flat).toContain("confirmed");
      expect(flat).toContain("Prev");
      expect(flat).toContain("Next");
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{approvalsView}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{approvalsView}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("tx-1");
      expect(html).toContain("connected");
      expect(html).toContain('data-agent-id="approve-queue-1"');
      expect(html).toContain('data-agent-id="reject-queue-1"');
      expect(html).toContain('data-agent-id="tab-history"');
    }
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView(
      "steward-test",
      () => approvalsView,
    );
    try {
      const component = getTerminalView("steward-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("tx-1");
    } finally {
      unregister();
    }
  });
});
