/**
 * Drives IncidentReportPanel submit: empty toast, successful POST clear, and
 * 404 mailto fallback. jsdom with apiFetch/ApiError/sonner mocked.
 */
// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { apiFetchMock: vi.fn(), ApiError };
});

vi.mock("../../lib/api-client", () => ({
  apiFetch: apiFetchMock,
  ApiError,
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { toast } from "sonner";
import { IncidentReportPanel } from "./incident-report-panel";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_SOURCE = path.join(HERE, "incident-report-panel.tsx");
const SECURITY_EMAIL = "security@elizaos.ai";

describe("IncidentReportPanel", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("composes the canonical settings rows", () => {
    const source = readFileSync(PANEL_SOURCE, "utf8");
    expect(source).toContain("SettingsStack");
    expect(source).toContain("SettingsGroup");
    expect(source).toContain("SettingsTextareaRow");
    expect(source).toContain("SettingsActionButton");
  });

  it("toasts and does not POST when details are empty", () => {
    render(<IncidentReportPanel />);

    fireEvent.click(
      screen.getByRole("button", { name: "Submit incident report" }),
    );

    expect(toast.error).toHaveBeenCalledWith("Please describe what happened.");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("toasts and does not POST when details are only whitespace", () => {
    render(<IncidentReportPanel />);

    fireEvent.change(screen.getByLabelText("Incident details"), {
      target: { value: "   \n\t  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Submit incident report" }),
    );

    expect(toast.error).toHaveBeenCalledWith("Please describe what happened.");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the trimmed details, toasts success, and clears the textarea", async () => {
    apiFetchMock.mockResolvedValueOnce({});
    render(<IncidentReportPanel />);

    const field = screen.getByLabelText("Incident details");
    fireEvent.change(field, {
      target: { value: "  Phishing email at https://example.com  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Submit incident report" }),
    );

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/security/incident", {
        method: "POST",
        json: { details: "Phishing email at https://example.com" },
      });
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Incident report submitted. We'll follow up by email.",
    );
    expect((field as HTMLTextAreaElement).value).toBe("");
  });

  it("assigns the security mailto fallback when the endpoint returns 404", async () => {
    const location = { href: "https://eliza.example/settings#cloud-security" };
    vi.stubGlobal("location", location);
    apiFetchMock.mockRejectedValueOnce(
      new ApiError(404, "not_found", "Not Found"),
    );

    render(<IncidentReportPanel />);
    fireEvent.change(screen.getByLabelText("Incident details"), {
      target: { value: "Unexpected token leak in the billing invoice PDF." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Submit incident report" }),
    );

    const expectedMailto = `mailto:${SECURITY_EMAIL}?subject=${encodeURIComponent(
      "Security incident report",
    )}&body=${encodeURIComponent(
      "Unexpected token leak in the billing invoice PDF.",
    )}`;
    await waitFor(() => {
      expect(location.href).toBe(expectedMailto);
    });
    expect(toast.success).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("disables the field and submit while the POST is in flight", async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    apiFetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    render(<IncidentReportPanel />);
    const field = screen.getByLabelText("Incident details");
    fireEvent.change(field, {
      target: { value: "Compromised session token." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Submit incident report" }),
    );

    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "Submitting…",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
    expect((field as HTMLTextAreaElement).disabled).toBe(true);

    resolveFetch({});
    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "Submit incident report",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
  });

  it("keeps the mailto link in the group description", () => {
    render(<IncidentReportPanel />);
    const link = screen.getByRole("link", { name: SECURITY_EMAIL });
    expect(link.getAttribute("href")).toBe(`mailto:${SECURITY_EMAIL}`);
    expect(screen.getByText("Report a security incident")).toBeTruthy();
  });
});
