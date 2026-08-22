/**
 * Renders ProfileForm through SettingsInputRow and asserts name save plus
 * add-email against mocked apiFetch. jsdom, no backend.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../data/user";
import { ProfileForm } from "./profile-form";

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  apiFetch: apiFetchMock,
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function jsonResponse(body: unknown) {
  return {
    json: async () => body,
  };
}

function makeUser(overrides: Partial<UserProfile> = {}): UserProfile {
  const now = new Date("2026-03-15T12:00:00.000Z");
  return {
    id: "user-1",
    email: "user@example.com",
    email_verified: true,
    wallet_address: null,
    wallet_chain_type: null,
    wallet_verified: false,
    name: "Ada",
    avatar: null,
    organization_id: null,
    role: "member",
    steward_user_id: null,
    telegram_id: null,
    telegram_username: null,
    telegram_first_name: null,
    telegram_photo_url: null,
    discord_id: null,
    discord_username: null,
    discord_global_name: null,
    discord_avatar_url: null,
    phone_number: null,
    phone_verified: null,
    is_anonymous: false,
    anonymous_session_id: null,
    expires_at: null,
    nickname: null,
    work_function: null,
    preferences: null,
    email_notifications: null,
    response_notifications: null,
    is_active: true,
    created_at: now,
    updated_at: now,
    organization: null,
    ...overrides,
  };
}

const reloadMock = vi.fn();

describe("ProfileForm", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    reloadMock.mockReset();
    vi.stubGlobal("location", { reload: reloadMock });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("routes name and present email through SettingsInputRow and disables email", () => {
    render(<ProfileForm user={makeUser()} />);

    expect(screen.getByText("Profile information")).toBeTruthy();
    const name = screen.getByLabelText("Full name");
    const email = screen.getByLabelText("Email address");
    expect(name.getAttribute("data-agent-id")).toBe("profile-name");
    expect(email.getAttribute("data-agent-id")).toBe("profile-email");
    expect(email).toHaveProperty("disabled", true);
    expect(
      screen.queryByRole("button", { name: "Add email address" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    const help = screen.getByText(
      "Email cannot be changed. Contact support if you need to update this.",
    );
    expect(
      email.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("submits the name through PATCH /api/v1/user and reloads on success", async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        message: "Profile updated successfully",
      }),
    );

    render(<ProfileForm user={makeUser()} />);

    fireEvent.change(screen.getByLabelText("Full name"), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/user", {
        method: "PATCH",
        json: { name: "Ada Lovelace" },
      });
    });
    expect(await screen.findByTestId("profile-success")).toBeTruthy();
    expect(screen.getByTestId("profile-success").textContent).toContain(
      "Profile updated successfully",
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("adds a missing email through PATCH /api/v1/user/email and reloads", async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        message: "Email added successfully",
      }),
    );

    render(<ProfileForm user={makeUser({ email: null })} />);

    const email = screen.getByLabelText("Email address");
    expect(email).toHaveProperty("disabled", false);
    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add email address" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/user/email", {
        method: "PATCH",
        json: { email: "ada@example.com" },
      });
    });
    expect(await screen.findByTestId("profile-success")).toBeTruthy();
    expect(screen.getByTestId("profile-success").textContent).toContain(
      "Email added successfully",
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed name save on the error alert and does not reload", async () => {
    apiFetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        error: "Name is too long",
      }),
    );

    render(<ProfileForm user={makeUser()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByTestId("profile-error")).toBeTruthy();
    expect(screen.getByTestId("profile-error").textContent).toContain(
      "Name is too long",
    );
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
