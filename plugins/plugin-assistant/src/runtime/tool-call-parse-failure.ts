import { modelProviderErrorDetail } from "@elizaos/core";

/**
 * True when the provider answered a request with a 400 saying it could not
 * parse a tool call out of the model's own generation. Cerebras returns this
 * under `tool_choice: "required"` as a flat body
 * `{"type":"generation_error","param":"tool_calls","code":"parser_error"}`
 * (resident evals, November 2026: 2 of 15 Stage 1 calls that reasoned after a
 * history read, none of 921 that did not). The request was valid and the
 * provider failed on what the model sampled, so it may be sent again; a
 * 400 for any other reason (schema, context length, malformed request) is the
 * caller's and is never matched here.
 *
 * Structural: the HTTP status and the body's `code` and `param` fields, read
 * from the response body the AI SDK keeps on the error. The body excerpt is
 * bounded, so when it does not parse whole the two fields are matched as JSON
 * keys at the top of the body, where the provider writes them.
 */
export function isProviderToolCallParseFailure(error: unknown): boolean {
  const detail = modelProviderErrorDetail(error);
  if (detail?.status !== 400 || !detail.responseBodyExcerpt) return false;
  const body = detail.responseBodyExcerpt;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    const fields =
      parsed && typeof parsed.error === "object" && parsed.error !== null
        ? (parsed.error as Record<string, unknown>)
        : parsed;
    return fields?.code === "parser_error" && fields.param === "tool_calls";
  } catch {
    // error-policy:J3 A truncated excerpt is not JSON; its leading fields still are.
    return (
      /"code"\s*:\s*"parser_error"/.test(body) &&
      /"param"\s*:\s*"tool_calls"/.test(body)
    );
  }
}
