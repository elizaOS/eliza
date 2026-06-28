// @vitest-environment jsdom

/**
 * Real behavior tests for CredentialRequestWidget: each of the three variants
 * renders its expected chrome, and every control reports the exact payload the
 * host wires up. No transport is mocked away; the widget's own state (the
 * paste-secret input + trim/empty gating) runs for real.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRequestWidget } from "./credential-request-widget";

afterEach(cleanup);

describe("CredentialRequestWidget - oauth-link", () => {
  it("renders the authorize button and reports the authorize url on click", () => {
    const onAuthorize = vi.fn();
    render(
      <CredentialRequestWidget
        variant={{
          kind: "oauth-link",
          provider: "GitHub",
          authorizeUrl: "https://github.com/login/oauth/authorize",
          status: "idle",
        }}
        onAuthorize={onAuthorize}
      />,
    );

    expect(screen.getByTestId("credential-request")).toBeTruthy();
    expect(
      screen
        .getByTestId("credential-request")
        .getAttribute("data-credential-kind"),
    ).toBe("oauth-link");

    fireEvent.click(screen.getByTestId("credential-oauth-authorize"));

    expect(onAuthorize).toHaveBeenCalledTimes(1);
    expect(onAuthorize).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize",
    );
  });

  it("disables the button and shows connecting copy while connecting", () => {
    render(
      <CredentialRequestWidget
        variant={{
          kind: "oauth-link",
          provider: "GitHub",
          authorizeUrl: "https://github.com/login/oauth/authorize",
          status: "connecting",
        }}
        onAuthorize={vi.fn()}
      />,
    );

    const button = screen.getByTestId(
      "credential-oauth-authorize",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/Connecting/);
  });

  it("shows a connected status and no authorize button when connected", () => {
    render(
      <CredentialRequestWidget
        variant={{
          kind: "oauth-link",
          provider: "Notion",
          authorizeUrl: "https://example.com/authorize",
          status: "connected",
        }}
        onAuthorize={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("credential-oauth-connected").textContent,
    ).toMatch(/Connected to Notion/);
    expect(screen.queryByTestId("credential-oauth-authorize")).toBeNull();
  });
});

describe("CredentialRequestWidget - paste-secret", () => {
  it("submits the trimmed secret value on click", () => {
    const onSubmitSecret = vi.fn();
    render(
      <CredentialRequestWidget
        variant={{
          kind: "paste-secret",
          label: "OpenAI API key",
          placeholder: "sk-...",
          helpText: "Stored encrypted in your vault.",
        }}
        onSubmitSecret={onSubmitSecret}
      />,
    );

    expect(screen.getByText("Stored encrypted in your vault.")).toBeTruthy();

    fireEvent.change(screen.getByTestId("credential-secret-input"), {
      target: { value: "  sk-live-123  " },
    });
    fireEvent.click(screen.getByTestId("credential-secret-submit"));

    expect(onSubmitSecret).toHaveBeenCalledTimes(1);
    expect(onSubmitSecret).toHaveBeenCalledWith("sk-live-123");
  });

  it("keeps submit disabled and does not fire for an empty/whitespace value", () => {
    const onSubmitSecret = vi.fn();
    render(
      <CredentialRequestWidget
        variant={{ kind: "paste-secret", label: "OpenAI API key" }}
        onSubmitSecret={onSubmitSecret}
      />,
    );

    const submit = screen.getByTestId(
      "credential-secret-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("credential-secret-input"), {
      target: { value: "   " },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);

    expect(onSubmitSecret).not.toHaveBeenCalled();
  });
});

describe("CredentialRequestWidget - image-upload", () => {
  it("reports the selected file", () => {
    const onSubmitImage = vi.fn();
    render(
      <CredentialRequestWidget
        variant={{ kind: "image-upload", label: "2FA QR code" }}
        onSubmitImage={onSubmitImage}
      />,
    );

    const input = screen.getByTestId(
      "credential-image-input",
    ) as HTMLInputElement;
    const file = new File(["qr"], "qr.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onSubmitImage).toHaveBeenCalledTimes(1);
    expect(onSubmitImage).toHaveBeenCalledWith(file);
  });

  it("renders a preview image when a previewUrl is supplied", () => {
    render(
      <CredentialRequestWidget
        variant={{
          kind: "image-upload",
          label: "Seed phrase photo",
          previewUrl: "blob:preview",
        }}
        onSubmitImage={vi.fn()}
      />,
    );

    const preview = screen.getByTestId(
      "credential-image-preview",
    ) as HTMLImageElement;
    expect(preview.getAttribute("src")).toBe("blob:preview");
  });
});
