/** Preserves explicit product funding through model errors so runtime fallback cannot spend from another payer. */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { getNativeApplicationSlot } from "./config";

export function nativeFundingFailure(slotKey: string | undefined, cause: unknown): unknown {
  if (slotKey === undefined) return cause;
  if (cause instanceof ElizaError && cause.code === "MODEL_FUNDING_AUTHORITY_FAILED") return cause;
  return new ElizaError("Application-funded inference failed; recover the original operation before trying again", {
    code: "MODEL_FUNDING_AUTHORITY_FAILED", cause, context: { slotKey },
  });
}

export async function withNativeFundingAuthority<T>(runtime: IAgentRuntime, run: () => Promise<T>): Promise<T> {
  const slotKey = getNativeApplicationSlot(runtime);
  try { return await run(); }
  catch (error) {
    // error-policy:J2 Preserve the original error under the selected payer's non-fallback boundary.
    throw nativeFundingFailure(slotKey, error);
  }
}
