/**
 * Subscription credential rotation around one-shot SDK completions. Canonical
 * account-pool leases are tried with a stable logical session key; when none are
 * selectable, the externally managed Claude Code keychain is one final epoch.
 */

import { createHmac } from "node:crypto";
import {
  ClaudeCompletionError,
  ClaudeRateLimitError,
} from "./claude-completion.js";
import type {
  ClaudeCompletionResult,
  CompletionContext,
  CompletionRunner,
} from "./types.js";

const MAX_LINKED_ATTEMPTS = 64;

export interface CredentialBrokerLease {
  leaseId: string;
  providerId: string;
  accountId: string;
  accessToken: string;
}

export interface CredentialLeaseBroker {
  lease(request: {
    providerId: "anthropic-subscription";
    sessionKey: string;
    strategy: "quota-aware";
    exclude?: string[];
  }): Promise<CredentialBrokerLease | null>;
  report(request: {
    leaseId: string;
    ok: boolean;
    httpStatus?: number;
    errorCode?: string;
    retryAfterMs?: number;
    tokens?: number;
    model?: string;
  }): Promise<unknown>;
  release(request: { leaseId: string }): unknown;
  health?(): {
    providers: Array<{
      providerId: string;
      total: number;
      selectable: number;
    }>;
  };
}

export interface RotatingCredentialCompletionRunnerOptions {
  completionRunner: CompletionRunner;
  broker?: CredentialLeaseBroker | null;
  hmacKey: Buffer;
  now?: () => number;
  expectedTierHmacSha256?: string | null;
  expectedCapabilityHmacSha256?: string | null;
  ambientFallbackAllowed?: boolean;
}

export class CredentialParityError extends ClaudeCompletionError {
  constructor() {
    super(
      "credential_capability_mismatch",
      "The selected subscription credential changed benchmark capability tier.",
      503,
    );
    this.name = "CredentialParityError";
  }
}

export class RotatingCredentialCompletionRunner implements CompletionRunner {
  private readonly inner: CompletionRunner;
  private readonly broker: CredentialLeaseBroker | null;
  private readonly hmacKey: Buffer;
  private readonly now: () => number;
  private expectedTierHash: string | null;
  private readonly capabilityHash: string;
  private readonly ambientFallbackAllowed: boolean;

  constructor(options: RotatingCredentialCompletionRunnerOptions) {
    if (options.hmacKey.length < 32) {
      throw new TypeError(
        "Credential HMAC key must contain at least 32 bytes.",
      );
    }
    this.inner = options.completionRunner;
    this.broker = options.broker ?? null;
    this.hmacKey = Buffer.from(options.hmacKey);
    this.now = options.now ?? Date.now;
    this.ambientFallbackAllowed = options.ambientFallbackAllowed ?? true;
    this.capabilityHash = this.hmac("firstParty:oauth:subscription");
    if (
      options.expectedCapabilityHmacSha256 &&
      options.expectedCapabilityHmacSha256 !== this.capabilityHash
    ) {
      throw new CredentialParityError();
    }
    this.expectedTierHash = options.expectedTierHmacSha256 ?? null;
  }

  async complete(context: CompletionContext): Promise<ClaudeCompletionResult> {
    const excluded: string[] = [];
    let earliestKnownReset: number | null = null;
    let knownRateLimitType: string | null = null;
    let sawRateLimit = false;
    let lastAuthenticationFailure: unknown = null;
    for (let attempt = 0; attempt < MAX_LINKED_ATTEMPTS; attempt += 1) {
      const lease = this.broker
        ? await this.broker.lease({
            providerId: "anthropic-subscription",
            sessionKey: `claude-benchmark:${context.requestId}`,
            strategy: "quota-aware",
            // Snapshot the exclusions per request: this array is mutated
            // (excluded.push) after each lease, so passing the live reference
            // would let the broker observe accounts excluded on LATER attempts.
            ...(excluded.length > 0 ? { exclude: [...excluded] } : {}),
          })
        : null;
      if (lease === null) break;
      if (
        lease.providerId !== "anthropic-subscription" ||
        excluded.includes(lease.accountId)
      ) {
        throw new CredentialParityError();
      }
      excluded.push(lease.accountId);
      try {
        const result = await this.inner.complete({
          ...context,
          credentialOAuthToken: lease.accessToken,
          credentialTierValidator: (subscriptionType) =>
            this.assertTierParity(subscriptionType),
        });
        const decorated = this.decorateResult(
          result,
          `linked:${lease.accountId}`,
        );
        await this.broker?.report({
          leaseId: lease.leaseId,
          ok: true,
          tokens: totalTokens(result),
          model: result.model,
        });
        return decorated;
      } catch (error: unknown) {
        if (error instanceof ClaudeRateLimitError) {
          sawRateLimit = true;
          if (
            error.retryAtMs !== null &&
            (earliestKnownReset === null ||
              error.retryAtMs < earliestKnownReset)
          ) {
            earliestKnownReset = error.retryAtMs;
            knownRateLimitType = error.rateLimitType;
          }
          await this.broker?.report({
            leaseId: lease.leaseId,
            ok: false,
            httpStatus: 429,
            errorCode: error.code,
            ...(error.retryAtMs === null
              ? {}
              : { retryAfterMs: Math.max(1, error.retryAtMs - this.now()) }),
            model: context.canonical.request.model,
          });
          continue;
        }
        if (isAuthenticationFailure(error)) {
          lastAuthenticationFailure = error;
          await this.broker?.report({
            leaseId: lease.leaseId,
            ok: false,
            httpStatus: 401,
            errorCode: safeCompletionCode(error),
            model: context.canonical.request.model,
          });
          continue;
        }
        await this.broker?.report({
          leaseId: lease.leaseId,
          ok: false,
          errorCode: safeCompletionCode(error),
          model: context.canonical.request.model,
        });
        throw error;
      } finally {
        this.broker?.release({ leaseId: lease.leaseId });
      }
    }

    if (!this.ambientFallbackAllowed) {
      if (!sawRateLimit && lastAuthenticationFailure !== null) {
        throw lastAuthenticationFailure;
      }
      throw new ClaudeRateLimitError(earliestKnownReset, knownRateLimitType);
    }
    try {
      const ambient = await this.inner.complete({
        ...context,
        credentialTierValidator: (subscriptionType) =>
          this.assertTierParity(subscriptionType),
      });
      return this.decorateResult(ambient, "ambient-keychain");
    } catch (error: unknown) {
      if (error instanceof ClaudeRateLimitError) {
        if (
          error.retryAtMs !== null &&
          (earliestKnownReset === null || error.retryAtMs < earliestKnownReset)
        ) {
          earliestKnownReset = error.retryAtMs;
          knownRateLimitType = error.rateLimitType;
        }
        throw new ClaudeRateLimitError(earliestKnownReset, knownRateLimitType, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private decorateResult(
    result: ClaudeCompletionResult,
    epoch: string,
  ): ClaudeCompletionResult {
    if (result.sdkApiKeySource !== "none" || !result.subscriptionType) {
      throw new CredentialParityError();
    }
    const tierHash = this.assertTierParity(result.subscriptionType);
    return {
      ...result,
      credentialEpochHmacSha256: this.hmac(`epoch:${epoch}`),
      credentialTierHmacSha256: tierHash,
      credentialCapabilityHmacSha256: this.capabilityHash,
    };
  }

  private assertTierParity(subscriptionType: string): string {
    const tierHash = this.hmac(`tier:${subscriptionType}`);
    if (this.expectedTierHash !== null && this.expectedTierHash !== tierHash) {
      throw new CredentialParityError();
    }
    this.expectedTierHash = tierHash;
    return tierHash;
  }

  private hmac(value: string): string {
    return createHmac("sha256", this.hmacKey)
      .update(value, "utf8")
      .digest("hex");
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof ClaudeCompletionError &&
    (error.statusCode === 401 || /auth|oauth|credential/.test(error.code))
  );
}

function safeCompletionCode(error: unknown): string {
  return error instanceof ClaudeCompletionError
    ? error.code
    : "claude_sdk_unknown_failure";
}

function totalTokens(result: ClaudeCompletionResult): number {
  return (
    result.usage.inputTokens +
    result.usage.outputTokens +
    result.usage.cacheReadInputTokens +
    result.usage.cacheCreationInputTokens
  );
}
