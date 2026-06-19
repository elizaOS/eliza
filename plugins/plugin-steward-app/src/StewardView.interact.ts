// View-bundle `interact` capability handler, split out of StewardView.tsx so
// that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./steward-view-bundle.ts.
import {
  loadStewardTuiState,
  postStewardJson,
  type StewardTxRecordsResponse,
  stewardJson,
} from "./StewardView.helpers";
import type {
  StewardApprovalActionResponse,
  StewardPendingApproval,
} from "./types/steward";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-steward-state") {
    return { viewType: "tui", ...(await loadStewardTuiState()) };
  }

  if (capability === "terminal-steward-pending") {
    return {
      viewType: "tui",
      pending: await stewardJson<StewardPendingApproval[]>(
        "/api/wallet/steward-pending-approvals",
      ),
    };
  }

  if (capability === "terminal-steward-history") {
    const status = typeof params?.status === "string" ? params.status : "";
    const limit = typeof params?.limit === "number" ? params.limit : 50;
    const offset = typeof params?.offset === "number" ? params.offset : 0;
    const search = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (status) search.set("status", status);
    return {
      viewType: "tui",
      history: await stewardJson<StewardTxRecordsResponse>(
        `/api/wallet/steward-tx-records?${search}`,
      ),
    };
  }

  if (
    capability === "terminal-steward-approve" ||
    capability === "terminal-steward-deny"
  ) {
    const txId = typeof params?.txId === "string" ? params.txId.trim() : "";
    if (!txId) throw new Error("txId is required");
    const deny = capability === "terminal-steward-deny";
    return {
      viewType: "tui",
      result: await postStewardJson<StewardApprovalActionResponse>(
        deny ? "/api/wallet/steward-deny-tx" : "/api/wallet/steward-approve-tx",
        {
          txId,
          reason:
            typeof params?.reason === "string" ? params.reason : undefined,
        },
      ),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
