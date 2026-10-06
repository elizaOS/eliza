/** Verifies PrivacyPanel discloses server-authoritative privacy policy. */
// @vitest-environment jsdom
/**
 * Renders PrivacyPanel against a mocked Cloud API client: the recording policy
 * comes from `GET /api/v1/me/consents`, vision capture is left to device
 * permissions, and the data export verifies the digest before download.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const apiFetchMock = vi.hoisted(() => vi.fn());
const downloadAttachmentMock = vi.hoisted(() => vi.fn());
const emitAuditEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, api: apiMock, apiFetch: apiFetchMock };
});

vi.mock("../../lib/auth-query", () => ({
  useAuthenticatedQueryGate: () => ({ enabled: true, userId: "user-1" }),
  authenticatedQueryKey: (parts: readonly unknown[]) => [...parts, "auth"],
}));

vi.mock("../../../utils/download-share", () => ({
  downloadAttachment: downloadAttachmentMock,
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      key: string,
      options?: { defaultValue?: string; message?: string; days?: number },
    ): string =>
      (options?.defaultValue ?? key)
        .replace("{{message}}", options?.message ?? "")
        .replace("{{days}}", String(options?.days ?? "")),
}));

vi.mock("../data/audit-client", () => ({
  emitAuditEvent: emitAuditEventMock,
}));

vi.mock("../data/account-deletion-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../data/account-deletion-client")>();
  return {
    readVerifiedExportDownload: actual.readVerifiedExportDownload,
    submitAccountDeletion: vi.fn(),
    endLocalSessionAfterDeletion: vi.fn(),
  };
});

import { PrivacyPanel } from "./privacy-panel";

const visionRecord = (granted: boolean) => ({
  purpose: "vision_capture",
  granted,
  policyVersion: "2026-09-privacy-panel-v1",
  source: "cloud-ui",
  recordedAt: "2026-09-26T12:00:00.000Z",
});

type TestRecord = ReturnType<typeof visionRecord>;

/** A `GET /api/v1/me/consents` body as the server builds it. */
function consentList(
  records: TestRecord[],
  recording: { enabled: boolean; source?: string; retentionDays?: number } = {
    enabled: false,
  },
) {
  const defaults: Record<string, boolean> = { vision_capture: false };
  return {
    capture: {
      modelCallRecording: {
        enabled: recording.enabled,
        source: recording.source ?? "deployment-default",
        retentionDays: recording.retentionDays ?? 90,
      },
    },
    consents: records,
    effective: Object.entries(defaults).map(([purpose, defaultGranted]) => {
      const recorded = records.find((record) => record.purpose === purpose);
      return {
        purpose,
        granted: recorded ? recorded.granted : defaultGranted,
        basis: recorded ? "recorded" : "default",
        defaultGranted,
      };
    }),
  };
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PrivacyPanel />
    </QueryClientProvider>,
  );
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

beforeEach(() => {
  apiMock.mockReset();
  apiFetchMock.mockReset();
  downloadAttachmentMock.mockReset();
  emitAuditEventMock.mockReset();
  // jsdom has no object-URL support; the panel only hands the URL through.
  URL.createObjectURL = vi.fn(() => "blob:export");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("PrivacyPanel", () => {
  it("discloses that recording is off and defers vision to device permissions", async () => {
    apiMock.mockResolvedValueOnce(consentList([visionRecord(false)]));
    renderPanel();
    expect(screen.getByText("Loading your privacy choices…")).toBeTruthy();
    expect(screen.queryByTestId("model-call-recording-status")).toBeNull();

    const status = await screen.findByTestId("model-call-recording-status");
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/consents");
    expect(status.getAttribute("data-state")).toBe("off");
    expect(status.textContent).toBe(
      "Model-call recording is off on this deployment.",
    );
    expect(
      screen.getByText(
        "Manage camera and screen capture through your device permissions. Account-wide capture controls are not available yet.",
      ),
    ).toBeTruthy();
    // Neither vision nor recording is a per-user switch here.
    expect(screen.queryByRole("switch")).toBeNull();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("discloses recording with its retention window when the deployment records", async () => {
    apiMock.mockResolvedValueOnce(
      consentList([], { enabled: true, retentionDays: 30 }),
    );
    renderPanel();
    const status = await screen.findByTestId("model-call-recording-status");
    expect(status.getAttribute("data-state")).toBe("on");
    expect(status.textContent).toBe(
      "This deployment records model calls to improve Eliza. Recordings are encrypted and deleted after 30 days.",
    );
  });

  it("rejects a consent list without the recording policy", async () => {
    const { capture: _capture, ...withoutCapture } = consentList([]);
    apiMock.mockResolvedValueOnce(withoutCapture);
    renderPanel();
    expect(
      await screen.findByText(
        "Consent list response is missing the model-call recording policy",
      ),
    ).toBeTruthy();
  });

  it("rejects a consent list without the server's effective policy", async () => {
    apiMock.mockResolvedValueOnce({ consents: [] });
    renderPanel();
    expect(
      await screen.findByText("Consent list response is malformed"),
    ).toBeTruthy();
  });

  it("shows a load error with retry and never falls back to local state", async () => {
    apiMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(consentList([], { enabled: true }));
    renderPanel();
    expect(await screen.findByText("network down")).toBeTruthy();
    expect(screen.queryByTestId("model-call-recording-status")).toBeNull();

    fireEvent.click(screen.getByTestId("privacy-consents-retry"));
    expect(
      (await screen.findByTestId("model-call-recording-status")).getAttribute(
        "data-state",
      ),
    ).toBe("on");
  });

  it("rejects a malformed consent payload instead of rendering it", async () => {
    apiMock.mockResolvedValueOnce({
      consents: [{ purpose: "vision_capture" }],
      effective: [],
    });
    renderPanel();
    expect(await screen.findByText("Consent record is malformed")).toBeTruthy();
  });

  it("downloads a digest-verified live-account export", async () => {
    apiMock.mockResolvedValueOnce(consentList([]));
    const bytes = new TextEncoder().encode('{"tables":{}}');
    apiFetchMock.mockResolvedValueOnce(
      new Response(bytes, {
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="eliza-export.json"',
          "X-Account-Deletion-Export-SHA256": await sha256Hex(bytes),
        },
      }),
    );
    renderPanel();
    fireEvent.click(screen.getByTestId("privacy-export-button"));

    expect(await screen.findByText(/Export ready/)).toBeTruthy();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/me/data-export", {
      method: "POST",
      json: {},
    });
    expect(downloadAttachmentMock).toHaveBeenCalledWith(
      "blob:export",
      "eliza-export.json",
    );
  });

  it("refuses an export whose bytes do not match the server digest", async () => {
    apiMock.mockResolvedValueOnce(consentList([]));
    apiFetchMock.mockResolvedValueOnce(
      new Response("tampered", {
        status: 200,
        headers: { "X-Account-Deletion-Export-SHA256": "a".repeat(64) },
      }),
    );
    renderPanel();
    fireEvent.click(screen.getByTestId("privacy-export-button"));

    expect(
      await screen.findByText(/do not match the server receipt/),
    ).toBeTruthy();
    expect(downloadAttachmentMock).not.toHaveBeenCalled();
  });

  it("tells the user when their export exceeds the size limit", async () => {
    apiMock.mockResolvedValueOnce(consentList([]));
    const { ApiError } = await import("../../lib/api-client");
    apiFetchMock.mockRejectedValueOnce(
      new ApiError(413, "EXPORT_TOO_LARGE", "Export too large"),
    );
    renderPanel();
    fireEvent.click(screen.getByTestId("privacy-export-button"));

    expect(
      await screen.findByText(/larger than the self-service export limit/),
    ).toBeTruthy();
    expect(downloadAttachmentMock).not.toHaveBeenCalled();
  });

  it("keeps account deletion behind its lifecycle dialog", async () => {
    apiMock.mockResolvedValueOnce(consentList([]));
    renderPanel();
    const del = screen.getByTestId(
      "delete-account-trigger",
    ) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
  });
});
