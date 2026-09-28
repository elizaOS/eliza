/** Verifies PrivacyPanel renders and records server-authoritative consent. */
// @vitest-environment jsdom
/**
 * Renders PrivacyPanel against a mocked Cloud API client: consent comes from
 * `GET /api/v1/me/consents`, changes are `POST`ed and reflected only from the
 * server receipt, and the data export verifies the digest before download.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
      options?: { defaultValue?: string; message?: string },
    ): string =>
      (options?.defaultValue ?? key).replace(
        "{{message}}",
        options?.message ?? "",
      ),
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
function consentList(records: TestRecord[], trainingDefault = true) {
  const defaults: Record<string, boolean> = {
    vision_capture: false,
    trajectory_training: trainingDefault,
  };
  return {
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
  it("renders server consent, with the training default stated when unset", async () => {
    apiMock.mockResolvedValueOnce(consentList([visionRecord(false)]));
    renderPanel();
    const vision = screen.getByTestId("vision-toggle");
    expect(vision.getAttribute("role")).toBe("switch");
    expect(vision.getAttribute("data-agent-id")).toBe("cloud-privacy-vision");
    expect(screen.getByText("Loading your privacy choices…")).toBeTruthy();
    expect(vision.hasAttribute("disabled")).toBe(true);

    await waitFor(() => expect(vision.hasAttribute("disabled")).toBe(false));
    expect(apiMock).toHaveBeenCalledWith("/api/v1/me/consents");
    expect(vision.getAttribute("aria-checked")).toBe("false");
    const trajectory = screen.getByTestId("trajectory-toggle");
    expect(trajectory.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/the Cloud default \(on\) applies/)).toBeTruthy();
  });

  it("renders the opt-in server default when training consent is required", async () => {
    apiMock.mockResolvedValueOnce(consentList([], false));
    renderPanel();
    const trajectory = screen.getByTestId("trajectory-toggle");
    await waitFor(() =>
      expect(trajectory.hasAttribute("disabled")).toBe(false),
    );
    expect(trajectory.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/the Cloud default \(off\) applies/)).toBeTruthy();
    expect(screen.queryByText(/the Cloud default \(on\) applies/)).toBeNull();
  });

  it("renders an explicit grant without the default note", async () => {
    apiMock.mockResolvedValueOnce(
      consentList(
        [{ ...visionRecord(true), purpose: "trajectory_training" }],
        false,
      ),
    );
    renderPanel();
    const trajectory = screen.getByTestId("trajectory-toggle");
    await waitFor(() =>
      expect(trajectory.hasAttribute("disabled")).toBe(false),
    );
    expect(trajectory.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(/the Cloud default/)).toBeNull();
  });

  it("rejects a consent list without the server's effective policy", async () => {
    apiMock.mockResolvedValueOnce({ consents: [] });
    renderPanel();
    expect(
      await screen.findByText("Consent list response is malformed"),
    ).toBeTruthy();
  });

  it("records a consent change on the server and shows the receipt", async () => {
    apiMock
      .mockResolvedValueOnce(consentList([]))
      .mockResolvedValueOnce({ consent: visionRecord(true) });
    renderPanel();
    const vision = screen.getByTestId("vision-toggle");
    await waitFor(() => expect(vision.hasAttribute("disabled")).toBe(false));

    fireEvent.click(vision);
    await waitFor(() =>
      expect(vision.getAttribute("aria-checked")).toBe("true"),
    );
    expect(apiMock).toHaveBeenLastCalledWith("/api/v1/me/consents", {
      method: "POST",
      json: {
        purpose: "vision_capture",
        granted: true,
        policyVersion: "2026-09-privacy-panel-v1",
      },
    });
    // The server emits the audit event with the recorded result.
    expect(emitAuditEventMock).not.toHaveBeenCalled();
  });

  it("keeps the prior state and shows an error when recording fails", async () => {
    apiMock
      .mockResolvedValueOnce(consentList([visionRecord(false)]))
      .mockRejectedValueOnce(new Error("consent store offline"));
    renderPanel();
    const vision = screen.getByTestId("vision-toggle");
    await waitFor(() => expect(vision.hasAttribute("disabled")).toBe(false));

    fireEvent.click(vision);
    expect(
      (await screen.findByTestId("privacy-consent-error")).textContent,
    ).toContain("consent store offline");
    expect(vision.getAttribute("aria-checked")).toBe("false");
  });

  it("shows a load error with retry and never falls back to local state", async () => {
    apiMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(consentList([visionRecord(true)]));
    renderPanel();
    expect(await screen.findByText("network down")).toBeTruthy();
    expect(screen.getByTestId("vision-toggle").hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.click(screen.getByTestId("privacy-consents-retry"));
    await waitFor(() =>
      expect(
        screen.getByTestId("vision-toggle").getAttribute("aria-checked"),
      ).toBe("true"),
    );
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
