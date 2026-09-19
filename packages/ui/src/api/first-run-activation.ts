/** Waits for the exact accepted first-run operation before callers enter chat. */
import {
  FirstRunActivationSchema,
  PostFirstRunResponseSchema,
} from "@elizaos/shared";

export async function waitForFirstRunActivation(
  response: unknown,
  readActivation: (operationId: string) => Promise<unknown>,
  timeoutMs = 420_000,
): Promise<void> {
  let activation = PostFirstRunResponseSchema.parse(response).activation;
  if (!activation) return;
  const operationId = activation.operationId;
  const deadline = Date.now() + timeoutMs;
  while (activation.status !== "succeeded") {
    if (activation.status === "failed" || activation.status === "rolled-back") {
      throw new Error(
        activation.error ??
          "The selected provider failed to activate. Retry setup.",
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "Provider activation is still pending. Check runtime diagnostics before retrying setup.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    activation = FirstRunActivationSchema.parse(
      await readActivation(operationId),
    );
    if (activation.operationId !== operationId) {
      throw new Error(
        "First-run activation returned a different operation receipt.",
      );
    }
  }
}
