import { isRecord } from '@babylon/shared';

export type PrivyApiDiagnostics = {
  errorName?: string;
  errorMessage?: string;
  status?: number;
  providerCode?: string;
  providerRequestId?: string;
  providerMessage?: string;
};

type ExtractPrivyApiDiagnosticsOptions = {
  redactJwtLike?: boolean;
};

function pickHeaderValue(
  headers: unknown,
  headerName: string
): string | undefined {
  if (!headers) return undefined;

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(headerName) ?? undefined;
  }

  if (isRecord(headers)) {
    const direct = headers[headerName];
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const lower = headers[headerName.toLowerCase()];
    if (typeof lower === 'string' && lower.length > 0) return lower;
  }

  return undefined;
}

export function redactJwtLikeTokens(text: string): string {
  // Redact JWT-like strings (base64url.base64url.base64url).
  const jwtLike =
    /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])/g;
  return text.replace(jwtLike, '[REDACTED_JWT]');
}

export function extractPrivyApiDiagnostics(
  error: unknown,
  options: ExtractPrivyApiDiagnosticsOptions = {}
): PrivyApiDiagnostics {
  const diagnostics: PrivyApiDiagnostics = {};
  const maybeRedact = (value: string): string =>
    options.redactJwtLike ? redactJwtLikeTokens(value) : value;

  if (error instanceof Error) {
    diagnostics.errorName = error.name;
    diagnostics.errorMessage = maybeRedact(error.message);
  } else if (typeof error === 'string') {
    diagnostics.errorMessage = maybeRedact(error);
  }

  if (!isRecord(error)) return diagnostics;

  const status = error.status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    diagnostics.status = status;
  }

  const providerRequestId =
    pickHeaderValue(error.headers, 'x-request-id') ??
    pickHeaderValue(error.headers, 'x-privy-request-id');
  if (providerRequestId) {
    diagnostics.providerRequestId = providerRequestId;
  }

  const providerError = error.error;
  if (isRecord(providerError)) {
    const providerCode = providerError.code;
    if (typeof providerCode === 'string' && providerCode.length > 0) {
      diagnostics.providerCode = providerCode;
    }

    const providerMessage = providerError.message;
    if (typeof providerMessage === 'string' && providerMessage.length > 0) {
      diagnostics.providerMessage = maybeRedact(providerMessage);
    }
  }

  return diagnostics;
}
