/**
 * Deterministic benchmark-call identities bind each harness lane to its request
 * order. The resulting request id is reproducible across process restarts, so
 * replay cannot accidentally reuse an id for different request content.
 */

import { createHash } from "node:crypto";
import { stableJson } from "./canonical.js";
import type { CanonicalChatCompletion } from "./types.js";

const SAFE_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LogicalRequest {
  harness: string;
  namespaceSha256: string;
  ordinal: number;
  requestSha256: string;
  model: string;
  reasoningEffort: string | null;
  logicalKeySha256: string;
  requestId: string;
}

export class LogicalRequestAllocator {
  private readonly nextOrdinalByHarness = new Map<string, number>();
  readonly namespaceSha256: string;

  constructor(private readonly namespace: string) {
    if (!SAFE_NAMESPACE_PATTERN.test(namespace)) {
      throw new TypeError(
        "Benchmark namespace must be 1-128 safe identifier characters.",
      );
    }
    this.namespaceSha256 = sha256(namespace);
  }

  allocate(
    harness: string,
    canonical: CanonicalChatCompletion,
  ): LogicalRequest {
    const ordinal = this.nextOrdinalByHarness.get(harness) ?? 0;
    this.nextOrdinalByHarness.set(harness, ordinal + 1);
    return makeLogicalRequest(
      harness,
      this.namespaceSha256,
      ordinal,
      canonical,
    );
  }
}

export function makeLogicalRequest(
  harness: string,
  namespaceSha256: string,
  ordinal: number,
  canonical: CanonicalChatCompletion,
): LogicalRequest {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TypeError("Logical request ordinal must be non-negative.");
  }
  const reasoningEffort = canonical.request.reasoningEffort ?? null;
  const logicalKeySha256 = computeLogicalKeySha256({
    harness,
    namespaceSha256,
    ordinal,
    requestSha256: canonical.requestSha256,
    model: canonical.request.model,
    reasoningEffort,
  });
  return {
    harness,
    namespaceSha256,
    ordinal,
    requestSha256: canonical.requestSha256,
    model: canonical.request.model,
    reasoningEffort,
    logicalKeySha256,
    requestId: `logical_${logicalKeySha256}`,
  };
}

export function computeLogicalKeySha256(input: {
  harness: string;
  namespaceSha256: string;
  ordinal: number;
  requestSha256: string;
  model: string;
  reasoningEffort: string | null;
}): string {
  return sha256(
    stableJson({
      harness: input.harness,
      logical_namespace_sha256: input.namespaceSha256,
      logical_ordinal: input.ordinal,
      model_requested: input.model,
      reasoning_effort: input.reasoningEffort,
      request_sha256: input.requestSha256,
    }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
