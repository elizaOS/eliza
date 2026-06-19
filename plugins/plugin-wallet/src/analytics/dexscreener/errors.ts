interface DexScreenerFetchErr {
  readonly response?: { readonly data?: { readonly message?: string } };
  readonly message?: string;
}

function isDexScreenerFetchErr(value: object): value is DexScreenerFetchErr {
  return "response" in value || "message" in value;
}

/** Best-effort message extraction for DexScreener HTTP / fetch failures. */
export function dexScreenerErrorMessage(caught: unknown): string {
  if (typeof caught === "string") return caught;
  if (caught instanceof Error) return caught.message;
  if (
    typeof caught === "object" &&
    caught !== null &&
    isDexScreenerFetchErr(caught)
  ) {
    const fromResponse = caught.response?.data?.message;
    const fromMsg = caught.message;
    return (
      (typeof fromResponse === "string" ? fromResponse : undefined) ??
      (typeof fromMsg === "string" ? fromMsg : undefined) ??
      "Request failed"
    );
  }
  return "Request failed";
}
