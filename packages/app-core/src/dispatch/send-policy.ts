/**
 * SendPolicy — the structural policy that decides, for a given outbound
 * message, whether it can be dispatched directly, must be enqueued for
 * approval, or must be dropped. Policies compose gate evaluations (handoff,
 * global pause, quiet hours, channel rate limits, …) into a single decision.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/messaging ->
 *               packages/app-core/src/dispatch/send-policy.ts)
 */

export interface SendCandidate {
  readonly channelId: string;
  readonly connectorId?: string;
  readonly origin: string;
  /** Opaque body the connector will eventually deliver. */
  readonly body: unknown;
  /** Optional caller-supplied metadata (priority, tags, …). */
  readonly metadata?: Record<string, unknown>;
}

export type SendDecision =
  | { readonly action: "send" }
  | { readonly action: "approve"; readonly reason: string }
  | { readonly action: "drop"; readonly reason: string };

export interface SendPolicy {
  evaluate(candidate: SendCandidate): Promise<SendDecision>;
}

export class StubSendPolicy implements SendPolicy {
  async evaluate(_candidate: SendCandidate): Promise<SendDecision> {
    throw new Error(
      "[StubSendPolicy] not implemented — see packages/app-core/src/dispatch/README.md",
    );
  }
}
