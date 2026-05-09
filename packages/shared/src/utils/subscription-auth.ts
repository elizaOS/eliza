export function formatSubscriptionRequestError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

export function normalizeOpenAICallbackInput(input: string):
  | {
      ok: true;
      code: string;
    }
  | {
      ok: false;
      error: string;
    } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "subscriptionstatus.PasteCallbackUrlFromLocalhost",
    };
  }

  const normalized =
    trimmed.startsWith("localhost:") || trimmed.startsWith("127.0.0.1:")
      ? `http://${trimmed}`
      : trimmed;

  // Allow raw codes in addition to full callback URLs.
  if (!normalized.includes("://")) {
    if (normalized.length > 4096) {
      return { ok: false, error: "subscriptionstatus.CallbackCodeTooLong" };
    }
    return { ok: true, code: normalized };
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, error: "subscriptionstatus.InvalidCallbackUrl" };
  }

  const hostOk =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    !hostOk ||
    parsed.port !== "1455" ||
    parsed.pathname !== "/auth/callback"
  ) {
    return {
      ok: false,
      error: "subscriptionstatus.ExpectedCallbackUrl",
    };
  }
  if (!parsed.searchParams.get("code")) {
    return {
      ok: false,
      error: "subscriptionstatus.CallbackUrlMissingCode",
    };
  }
  return { ok: true, code: normalized };
}
