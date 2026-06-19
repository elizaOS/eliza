// Shared data helpers for the Steward view, used by both StewardTuiView
// (in StewardView.tsx) and the `interact` capability handler
// (in StewardView.interact.ts). Kept out of the .tsx so that file exports only
// React components and stays Fast-Refresh-compatible in dev.
import type {
  StewardPendingApproval,
  StewardStatusResponse,
  StewardTxRecord,
} from "./types/steward";

export interface StewardTxRecordsResponse {
  records: StewardTxRecord[];
  total: number;
  offset: number;
  limit: number;
}

export async function stewardJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Steward request failed with ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export async function postStewardJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Steward request failed with ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export async function loadStewardTuiState(): Promise<{
  status: StewardStatusResponse;
  pending: StewardPendingApproval[];
  history: StewardTxRecordsResponse | null;
}> {
  const status = await stewardJson<StewardStatusResponse>(
    "/api/wallet/steward-status",
  );

  if (!status.connected) {
    return { status, pending: [], history: null };
  }

  const [pending, history] = await Promise.all([
    stewardJson<StewardPendingApproval[]>(
      "/api/wallet/steward-pending-approvals",
    ),
    stewardJson<StewardTxRecordsResponse>(
      "/api/wallet/steward-tx-records?limit=25&offset=0",
    ),
  ]);

  return { status, pending, history };
}
