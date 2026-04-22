/**
 * Policy engine + latency + cost tracking for cross-provider routing.
 *
 * The policy engine sits on top of the `handlerRegistry` and, given a
 * model type and a user-selected policy, decides which provider's handler
 * should serve the next request. The router-handler (registered at top
 * priority) calls `pickProvider` to make that decision.
 *
 * Policies:
 *   - manual       — honour `preferredProvider`; when no pref set, fall
 *                    through to the runtime's native priority order
 *                    (highest registered priority wins).
 *   - cheapest     — pick the provider with the lowest per-token cost.
 *   - fastest      — pick the provider with the lowest tracked p50 latency
 *                    (needs at least a few samples; falls back to native).
 *   - prefer-local — try local first; if it fails or has no handler,
 *                    fall through to the next-best non-local.
 *   - round-robin  — distribute load evenly across eligible providers.
 *
 * Latency is tracked in a ring buffer per provider per model type. Cost
 * is a static table of published per-million-token rates; local providers
 * are $0. Neither is exact — the goal is "good enough to discriminate"
 * rather than dollar-accurate billing.
 */

import type { HandlerRegistration } from "./handler-registry";
import type { RoutingPolicy } from "./routing-preferences";

/** Must match `ROUTER_PROVIDER` in `router-handler.ts`. */
const ROUTER_SELF_ID = "milady-router";

const STUB_HANDLER: HandlerRegistration["handler"] = async () => undefined;

const RING_SIZE = 32;

interface LatencySample {
  durationMs: number;
  at: number;
}

class RingBuffer {
  private buf: LatencySample[] = [];
  push(sample: LatencySample): void {
    this.buf.push(sample);
    if (this.buf.length > RING_SIZE) this.buf.shift();
  }
  p50(): number | null {
    if (this.buf.length === 0) return null;
    const sorted = [...this.buf].map((s) => s.durationMs).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? null;
  }
  size(): number {
    return this.buf.length;
  }
}

/**
 * Published per-million-token rates as of 2026-04. Keep conservative —
 * "cheapest" policy only needs relative ordering to be correct.
 * Sources: vendor pricing pages. Local / device-bridge = 0 because the
 * user already paid for the hardware.
 */
const COST_PER_MILLION_TOKENS: Partial<
  Record<string, { input: number; output: number }>
> = {
  "milady-local-inference": { input: 0, output: 0 },
  "milady-device-bridge": { input: 0, output: 0 },
  "capacitor-llama": { input: 0, output: 0 },
  /** Loopback Ollama — treat as $0 like other on-device inference for "cheapest". */
  ollama: { input: 0, output: 0 },
  anthropic: { input: 3, output: 15 },
  openai: { input: 2.5, output: 10 },
  grok: { input: 5, output: 15 },
  google: { input: 1.25, output: 5 },
  mistral: { input: 2, output: 6 },
  // Cloud is billed by the user's subscription — treat as free at the
  // resolver level; actual billing happens upstream.
  elizacloud: { input: 0, output: 0 },
};

interface ProviderStats {
  latency: Map<string /* modelType */, RingBuffer>;
  lastPicked: Map<string /* modelType */, number /* timestamp */>;
}

class PolicyEngine {
  private stats = new Map<string /* provider */, ProviderStats>();

  private statsFor(provider: string): ProviderStats {
    let s = this.stats.get(provider);
    if (!s) {
      s = { latency: new Map(), lastPicked: new Map() };
      this.stats.set(provider, s);
    }
    return s;
  }

  recordLatency(provider: string, modelType: string, durationMs: number): void {
    const s = this.statsFor(provider);
    let buf = s.latency.get(modelType);
    if (!buf) {
      buf = new RingBuffer();
      s.latency.set(modelType, buf);
    }
    buf.push({ durationMs, at: Date.now() });
  }

  recordPick(provider: string, modelType: string): void {
    this.statsFor(provider).lastPicked.set(modelType, Date.now());
  }

  p50(provider: string, modelType: string): number | null {
    return this.statsFor(provider).latency.get(modelType)?.p50() ?? null;
  }

  lastPicked(provider: string, modelType: string): number | null {
    return this.statsFor(provider).lastPicked.get(modelType) ?? null;
  }

  costOf(provider: string): number | null {
    const c = COST_PER_MILLION_TOKENS[provider];
    if (!c) return null;
    // Weighted sum (3:1 output:input is a typical chat ratio). Treat missing
    // output pricing as same as input.
    return c.input * 0.25 + c.output * 0.75;
  }

  /**
   * Pick a provider for this (modelType, policy) given the registry.
   * Returns the HandlerRegistration whose handler the router-handler
   * should dispatch to, or null if no eligible handler exists.
   *
   * `preferredProvider` is only honoured for policy === "manual".
   */
  pickProvider(args: {
    modelType: string;
    policy: RoutingPolicy;
    preferredProvider: string | null;
    candidates: HandlerRegistration[];
    /** Provider ID of the router itself — always excluded from candidates. */
    selfProvider: string;
  }): HandlerRegistration | null {
    const eligible = args.candidates
      .filter((c) => c.provider !== args.selfProvider)
      .slice()
      // Defensive sort — real callers already sort, but test fixtures and
      // non-registry callers might not, and a silent "pick-wrong" would be
      // worse than the extra O(n log n).
      .sort((a, b) => b.priority - a.priority);
    if (eligible.length === 0) return null;

    switch (args.policy) {
      case "manual": {
        if (args.preferredProvider) {
          const match = eligible.find(
            (c) => c.provider === args.preferredProvider,
          );
          if (match) return match;
        }
        // Fallback: highest native priority.
        return eligible[0] ?? null;
      }
      case "cheapest": {
        const ranked = [...eligible].sort((a, b) => {
          const ca = this.costOf(a.provider) ?? Number.POSITIVE_INFINITY;
          const cb = this.costOf(b.provider) ?? Number.POSITIVE_INFINITY;
          if (ca !== cb) return ca - cb;
          return b.priority - a.priority;
        });
        return ranked[0] ?? null;
      }
      case "fastest": {
        const ranked = [...eligible].sort((a, b) => {
          const la = this.p50(a.provider, args.modelType);
          const lb = this.p50(b.provider, args.modelType);
          // Untracked providers get Infinity → deprioritised until we
          // have samples. First call always falls through to native
          // priority via the tie-break.
          const va = la ?? Number.POSITIVE_INFINITY;
          const vb = lb ?? Number.POSITIVE_INFINITY;
          if (va !== vb) return va - vb;
          return b.priority - a.priority;
        });
        return ranked[0] ?? null;
      }
      case "prefer-local": {
        // Same-machine inference: in-app GGUF, on-device Capacitor, then Ollama
        // (typical loopback server). **WHY include ollama:** when the router
        // suppresses milady-local-inference because LM Studio/Ollama already
        // holds weights, "prefer-local" should still prefer loopback Ollama
        // before falling through to cloud OpenAI / Anthropic.
        const local = eligible.find(
          (c) =>
            c.provider === "milady-local-inference" ||
            c.provider === "capacitor-llama" ||
            c.provider === "ollama",
        );
        if (local) return local;
        const bridge = eligible.find(
          (c) => c.provider === "milady-device-bridge",
        );
        if (bridge) return bridge;
        return eligible[0] ?? null;
      }
      case "round-robin": {
        // Pick the one least-recently-picked. Ties broken by priority.
        const ranked = [...eligible].sort((a, b) => {
          const la = this.lastPicked(a.provider, args.modelType) ?? 0;
          const lb = this.lastPicked(b.provider, args.modelType) ?? 0;
          if (la !== lb) return la - lb;
          return b.priority - a.priority;
        });
        return ranked[0] ?? null;
      }
    }
  }

  /** For tests and diagnostics. */
  snapshot(): Record<string, Record<string, number | null>> {
    const out: Record<string, Record<string, number | null>> = {};
    for (const [provider, stats] of this.stats) {
      out[provider] = {};
      for (const [modelType, buf] of stats.latency) {
        const row = out[provider];
        if (row) row[modelType] = buf.p50();
      }
    }
    return out;
  }
}

export const policyEngine = new PolicyEngine();

/**
 * Preview which provider `pickProvider` would choose for `modelType` using
 * the same policy rules as the live router. Handlers are stubs — this is
 * for UI copy only. Excludes `milady-router` by default. Does **not** apply
 * `filterExecutableLocalGgufCandidates` (GGUF suppression) from
 * `router-handler.ts`.
 */
export function previewRouterPickFromRegistrations(args: {
  modelType: string;
  policy: RoutingPolicy;
  preferredProvider: string | null;
  registrations: ReadonlyArray<{
    modelType: string;
    provider: string;
    priority: number;
  }>;
  selfProvider?: string;
}): string | null {
  const self = args.selfProvider ?? ROUTER_SELF_ID;
  const candidates: HandlerRegistration[] = args.registrations
    .filter((r) => r.modelType === args.modelType && r.provider !== self)
    .map((r) => ({
      provider: r.provider,
      priority: r.priority,
      modelType: r.modelType,
      registeredAt: "",
      handler: STUB_HANDLER,
    }));
  if (candidates.length === 0) return null;
  return (
    policyEngine.pickProvider({
      modelType: args.modelType,
      policy: args.policy,
      preferredProvider: args.preferredProvider,
      candidates,
      selfProvider: self,
    })?.provider ?? null
  );
}
