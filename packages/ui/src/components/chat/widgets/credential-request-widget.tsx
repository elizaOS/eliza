/**
 * CredentialRequestWidget — presentational in-chat card for the three ways the
 * agent asks for a credential: link out to an OAuth consent page, paste a
 * secret, or upload an image (a 2FA QR / seed photo). It mirrors the visual
 * chrome of the real secret form ({@link SensitiveRequestBlock}) so the two
 * read as one family, but it is intentionally computation- and transport-free:
 * the host wires the actual save/authorize via the `onAction` callbacks. It is
 * a thin display layer over a discriminated `variant`, never a second secret
 * pipeline.
 */

import { CheckCircle2, ExternalLink, ImageUp, KeyRound } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "../../ui/button";

export type OAuthLinkVariant = {
  kind: "oauth-link";
  provider: string;
  authorizeUrl: string;
  status?: "idle" | "connecting" | "connected";
};

export type PasteSecretVariant = {
  kind: "paste-secret";
  label: string;
  placeholder?: string;
  helpText?: string;
};

export type ImageUploadVariant = {
  kind: "image-upload";
  label: string;
  accept?: string;
  previewUrl?: string;
};

export type CredentialRequestVariant =
  | OAuthLinkVariant
  | PasteSecretVariant
  | ImageUploadVariant;

export type CredentialRequestWidgetProps = {
  variant: CredentialRequestVariant;
  /** Begin the OAuth flow (host opens `authorizeUrl` in a popup). */
  onAuthorize?: (authorizeUrl: string) => void;
  /** Submit the pasted secret value. */
  onSubmitSecret?: (value: string) => void;
  /** Submit the selected image file. */
  onSubmitImage?: (file: File) => void;
};

function OAuthLink({
  variant,
  onAuthorize,
}: {
  variant: OAuthLinkVariant;
  onAuthorize?: (authorizeUrl: string) => void;
}) {
  const status = variant.status ?? "idle";
  if (status === "connected") {
    return (
      <div
        data-testid="credential-oauth-connected"
        className="flex items-center gap-2 text-xs text-accent"
        role="status"
      >
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        Connected to {variant.provider}
      </div>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      data-testid="credential-oauth-authorize"
      disabled={status === "connecting"}
      onClick={() => onAuthorize?.(variant.authorizeUrl)}
    >
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      {status === "connecting" ? "Connecting…" : `Connect ${variant.provider}`}
    </Button>
  );
}

function PasteSecret({
  variant,
  onSubmitSecret,
}: {
  variant: PasteSecretVariant;
  onSubmitSecret?: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSubmitSecret?.(trimmed);
  }, [onSubmitSecret, value]);

  return (
    <div className="space-y-2">
      <label className="block text-xs space-y-1">
        <span className="font-medium">{variant.label}</span>
        <input
          aria-label={variant.label}
          data-testid="credential-secret-input"
          className="w-full border border-border bg-bg px-2 py-1.5 text-sm"
          type="password"
          placeholder={variant.placeholder}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      {variant.helpText ? (
        <div className="text-xs text-muted">{variant.helpText}</div>
      ) : null}
      <Button
        type="button"
        size="sm"
        data-testid="credential-secret-submit"
        disabled={value.trim().length === 0}
        onClick={handleSubmit}
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
        Save secret
      </Button>
    </div>
  );
}

function ImageUpload({
  variant,
  onSubmitImage,
}: {
  variant: ImageUploadVariant;
  onSubmitImage?: (file: File) => void;
}) {
  return (
    <label className="block text-xs space-y-1">
      <span className="font-medium">{variant.label}</span>
      {variant.previewUrl ? (
        <img
          src={variant.previewUrl}
          alt={`${variant.label} preview`}
          data-testid="credential-image-preview"
          className="max-h-40 w-auto border border-border"
        />
      ) : null}
      <span className="flex items-center gap-2 text-muted">
        <ImageUp className="h-4 w-4" aria-hidden />
        <input
          aria-label={variant.label}
          data-testid="credential-image-input"
          className="w-full border border-border bg-bg px-2 py-1.5 text-sm"
          type="file"
          accept={variant.accept ?? "image/*"}
          // Mobile: prefer the rear camera for capturing a 2FA QR / seed photo.
          capture="environment"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) onSubmitImage?.(file);
          }}
        />
      </span>
    </label>
  );
}

function variantTitle(variant: CredentialRequestVariant): string {
  switch (variant.kind) {
    case "oauth-link":
      return `Connect ${variant.provider}`;
    case "paste-secret":
    case "image-upload":
      return variant.label;
  }
}

export function CredentialRequestWidget({
  variant,
  onAuthorize,
  onSubmitSecret,
  onSubmitImage,
}: CredentialRequestWidgetProps) {
  return (
    <div
      data-testid="credential-request"
      data-credential-kind={variant.kind}
      className="my-2 border border-border bg-card p-3 text-sm space-y-3"
    >
      <div className="font-medium">{variantTitle(variant)}</div>
      {variant.kind === "oauth-link" ? (
        <OAuthLink variant={variant} onAuthorize={onAuthorize} />
      ) : variant.kind === "paste-secret" ? (
        <PasteSecret variant={variant} onSubmitSecret={onSubmitSecret} />
      ) : (
        <ImageUpload variant={variant} onSubmitImage={onSubmitImage} />
      )}
    </div>
  );
}
