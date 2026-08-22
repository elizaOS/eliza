/** Tests the Cloud call-me dialog with deterministic profile and API doubles. */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../../cloud/lib/api-client", () => ({
  api: mocks.api,
  ApiError: class ApiError extends Error {
    body: unknown;

    constructor(message: string, body?: unknown) {
      super(message);
      this.body = body;
    }
  },
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

import { PstnCallButton } from "./pstn-call-button";

afterEach(cleanup);

describe("PstnCallButton", () => {
  beforeEach(() => {
    mocks.api.mockReset();
    mocks.success.mockReset();
    mocks.error.mockReset();
  });

  it("loads the verified profile and requests one idempotent outbound call", async () => {
    mocks.api
      .mockResolvedValueOnce({
        phone_number: "+14155550100",
        phone_verified: true,
      })
      .mockResolvedValueOnce({
        success: true,
        callSid: "CA11111111111111111111111111111111",
        status: "queued",
        to: "***0100",
      });
    const user = userEvent.setup();
    render(<PstnCallButton />);

    const trigger = await screen.findByRole("button", {
      name: "Have Eliza call me",
    });
    await user.click(trigger);
    await screen.findByDisplayValue("+14155550100");
    expect(
      (screen.getByLabelText("Phone number") as HTMLInputElement).readOnly,
    ).toBe(true);
    expect(document.body.textContent).not.toMatch(/808|788-1821/);
    expect(screen.getByText(/AI-generated voice/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Call me" }));

    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
    expect(mocks.api.mock.calls[0]).toEqual(["/api/v1/user"]);
    expect(mocks.api.mock.calls[1]?.[0]).toBe("/api/v1/twilio/voice/calls");
    expect(mocks.api.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      json: { to: "+14155550100" },
      headers: { "Idempotency-Key": expect.any(String) },
    });
    expect(mocks.success).toHaveBeenCalledWith("Eliza is calling ***0100");
    expect(await screen.findByRole("button", { name: "Hang up" })).toBeTruthy();
  });

  it("hangs up the active call with a separate idempotency key", async () => {
    mocks.api
      .mockResolvedValueOnce({
        phone_number: "+14155550100",
        phone_verified: true,
      })
      .mockResolvedValueOnce({
        success: true,
        callSid: "CA22222222222222222222222222222222",
        status: "queued",
        to: "***0100",
      })
      .mockResolvedValueOnce({
        success: true,
        callSid: "CA22222222222222222222222222222222",
        status: "hangup-requested",
        to: "***0100",
        answeredAt: null,
        terminalAt: null,
        hangupRequestedAt: "2026-08-22T08:00:00.000Z",
      });
    const user = userEvent.setup();
    render(<PstnCallButton />);

    await user.click(
      await screen.findByRole("button", { name: "Have Eliza call me" }),
    );
    await screen.findByDisplayValue("+14155550100");
    await user.click(screen.getByRole("button", { name: "Call me" }));
    await user.click(await screen.findByRole("button", { name: "Hang up" }));

    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(3));
    expect(mocks.api.mock.calls[2]?.[0]).toBe(
      "/api/v1/twilio/voice/calls/CA22222222222222222222222222222222",
    );
    expect(mocks.api.mock.calls[2]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { "Idempotency-Key": expect.any(String) },
    });
    expect(mocks.success).toHaveBeenCalledWith("Hangup requested");
  });

  it("does not enable calling for an unverified account phone", async () => {
    mocks.api.mockResolvedValueOnce({
      phone_number: "+14155550100",
      phone_verified: false,
    });
    const user = userEvent.setup();
    render(<PstnCallButton />);

    await user.click(
      await screen.findByRole("button", { name: "Have Eliza call me" }),
    );
    await screen.findByText(/add and verify this phone number/i);
    expect(
      (screen.getByRole("button", { name: "Call me" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("clears a previously loaded number when a profile refresh fails", async () => {
    mocks.api
      .mockResolvedValueOnce({
        phone_number: "+14155550100",
        phone_verified: true,
      })
      .mockRejectedValueOnce(new Error("Profile unavailable"));
    const user = userEvent.setup();
    render(<PstnCallButton />);

    const trigger = await screen.findByRole("button", {
      name: "Have Eliza call me",
    });
    await user.click(trigger);
    await screen.findByDisplayValue("+14155550100");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(trigger);

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Profile unavailable"),
    );
    expect(
      (screen.getByLabelText("Phone number") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByRole("button", { name: "Call me" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
