/** Persistence-boundary proof for completed workspace file mutations. */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type ActionResult,
  type AppliedEffectReceipt,
  ElizaError,
  type HandlerCallback,
  type IAgentRuntime,
} from "@elizaos/core";
import { userFacingSuccessResult } from "./format.js";
import { finalLineEnding } from "./text-boundary.js";

export async function fileEffectReceipt(params: {
  path: string;
  content: string;
  operation: "write" | "edit";
  acceptedBytes?: number;
}): Promise<AppliedEffectReceipt> {
  const expected = Buffer.from(params.content, "utf8");
  const providerAccepted = params.acceptedBytes !== undefined;
  if (providerAccepted) {
    if (params.acceptedBytes !== expected.byteLength) {
      throw new ElizaError(
        "Filesystem provider reported an unexpected written byte count.",
        {
          code: "FILE_WRITE_UNVERIFIED",
        },
      );
    }
  } else {
    const actual = await readFile(params.path);
    if (!actual.equals(expected)) {
      throw new ElizaError(
        "File changed before the completed write could be verified.",
        {
          code: "FILE_WRITE_UNVERIFIED",
        },
      );
    }
  }
  const version = `sha256:${createHash("sha256").update(expected).digest("hex")}`;
  const observedAt = new Date().toISOString();
  return {
    receiptId: `file:${randomUUID()}`,
    operation: `filesystem.${params.operation}`,
    resource: { kind: "filesystem.file", id: params.path, version },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt,
    outcome: "applied",
    commit: {
      kind: providerAccepted ? "provider_accepted" : "durable",
      id: `${params.path}#${version}`,
      committedAt: observedAt,
    },
  };
}

/** A failed confirmation cannot erase the completed filesystem mutation. */
export async function fileMutationResult(params: {
  runtime: IAgentRuntime;
  receipt: AppliedEffectReceipt;
  text: string;
  content: string;
  data: Record<string, unknown>;
  callback?: HandlerCallback;
}): Promise<ActionResult> {
  const data = {
    ...params.data,
    finalLineEnding: finalLineEnding(params.content),
  };
  if (params.callback) {
    try {
      await params.callback({ text: params.text, source: "coding-tools" });
    } catch (error) {
      // error-policy:J1 presentation failed after persistence. Preserve the
      // effect and use the existing non-replayable reply-failure contract.
      const diagnostic = error instanceof Error ? error.message : String(error);
      params.runtime.reportError?.(
        "coding-tools.file.confirmation",
        new ElizaError(
          "File confirmation delivery failed after the mutation committed.",
          { code: "FILE_CONFIRMATION_DELIVERY_FAILED", cause: error },
        ),
        { receiptId: params.receipt.receiptId },
      );
      return {
        success: true,
        text: params.text,
        data: { ...data, confirmationDeliveryError: diagnostic },
        effectReceipts: [params.receipt],
        replyFailure: {
          kind: "reply_generation_error",
          code: "FILE_CONFIRMATION_DELIVERY_FAILED",
          message:
            "File mutation committed, but confirmation delivery failed. Recorded effects are preserved; do not repeat the mutation to recover the reply.",
          transient: false,
        },
      };
    }
  }
  return {
    ...userFacingSuccessResult(params.text, data),
    effectReceipts: [params.receipt],
    userFacingEffectReceiptIds: [params.receipt.receiptId],
    verifiedUserFacing: true,
    turnComplete: true,
  };
}
