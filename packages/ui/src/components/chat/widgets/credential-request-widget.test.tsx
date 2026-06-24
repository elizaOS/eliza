// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialRequestWidget } from "./credential-request-widget";

afterEach(cleanup);

describe("CredentialRequestWidget", () => {
  describe("oauth-link variant", () => {
    it("renders a Connect button and authorizes with the url on click", () => {
      const onAuthorize = vi.fn();
      render(
        <CredentialRequestWidget
          variant={{
            kind: "oauth-link",
            provider: "GitHub",
            authorizeUrl: "https://example.com/oauth",
          }}
          onAuthorize={onAuthorize}
        />,
      );
      const card = screen.getByTestId("credential-request");
      expect(card.getAttribute("data-credential-kind")).toBe("oauth-link");
      fireEvent.click(screen.getByTestId("credential-oauth-authorize"));
      expect(onAuthorize).toHaveBeenCalledWith("https://example.com/oauth");
    });

    it("disables the button while connecting", () => {
      render(
        <CredentialRequestWidget
          variant={{
            kind: "oauth-link",
            provider: "GitHub",
            authorizeUrl: "https://example.com/oauth",
            status: "connecting",
          }}
        />,
      );
      expect(
        (screen.getByTestId("credential-oauth-authorize") as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });

    it("renders the connected state instead of a button", () => {
      render(
        <CredentialRequestWidget
          variant={{
            kind: "oauth-link",
            provider: "GitHub",
            authorizeUrl: "https://example.com/oauth",
            status: "connected",
          }}
        />,
      );
      expect(screen.getByTestId("credential-oauth-connected")).toBeTruthy();
      expect(
        screen.queryByTestId("credential-oauth-authorize"),
      ).toBeNull();
    });
  });

  describe("paste-secret variant", () => {
    it("keeps submit disabled until a value is typed, then submits trimmed", () => {
      const onSubmitSecret = vi.fn();
      render(
        <CredentialRequestWidget
          variant={{ kind: "paste-secret", label: "API key" }}
          onSubmitSecret={onSubmitSecret}
        />,
      );
      const submit = screen.getByTestId(
        "credential-secret-submit",
      ) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      fireEvent.change(screen.getByTestId("credential-secret-input"), {
        target: { value: "  sk-123  " },
      });
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);
      expect(onSubmitSecret).toHaveBeenCalledWith("sk-123");
    });

    it("renders the secret input as a password field (never plain text)", () => {
      render(
        <CredentialRequestWidget
          variant={{ kind: "paste-secret", label: "API key" }}
        />,
      );
      expect(
        screen.getByTestId("credential-secret-input").getAttribute("type"),
      ).toBe("password");
    });
  });

  describe("image-upload variant", () => {
    it("submits the selected file", () => {
      const onSubmitImage = vi.fn();
      render(
        <CredentialRequestWidget
          variant={{ kind: "image-upload", label: "2FA QR" }}
          onSubmitImage={onSubmitImage}
        />,
      );
      const file = new File(["x"], "qr.png", { type: "image/png" });
      fireEvent.change(screen.getByTestId("credential-image-input"), {
        target: { files: [file] },
      });
      expect(onSubmitImage).toHaveBeenCalledWith(file);
    });

    it("renders a preview when previewUrl is provided", () => {
      render(
        <CredentialRequestWidget
          variant={{
            kind: "image-upload",
            label: "2FA QR",
            previewUrl: "blob:preview",
          }}
        />,
      );
      expect(screen.getByTestId("credential-image-preview")).toBeTruthy();
    });
  });
});
