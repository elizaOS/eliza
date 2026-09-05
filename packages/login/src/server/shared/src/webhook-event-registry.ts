/**
 * webhook-event-registry.ts — a runtime-extensible set of valid webhook
 * event-type names.
 *
 * WHY THIS EXISTS
 * ---------------
 * the core's webhook event types are a CLOSED TypeScript union
 * (`WebhookEventType` in ./index.ts) and the API's webhook-config validation
 * checks a candidate event against a fixed list. that is correct for the core's
 * own events, but it means a PLUGIN that emits its own event type ("foo.bar")
 * cannot have that event accepted: the closed union rejects it at the type
 * level, and the config validator rejects it at runtime.
 *
 * Phase 2 of the plugin SDK lets a plugin DECLARE the event-type names it emits
 * (`StewardPlugin.webhookEvents`). the plugin host registers those names here at
 * composition time, so the runtime set of valid event types becomes:
 *
 *     core event types  ∪  every enabled plugin's declared event types
 *
 * the webhook-config validator and dispatcher consult this set instead of a
 * frozen list, so a plugin's event flows end-to-end without the core's union
 * having to enumerate it ahead of time. core events are ALWAYS valid (they are
 * seeded into the registry and can never be removed), so a plugin can only ADD
 * to the valid set, never shrink it.
 *
 * This is intentionally a tiny, dependency-free runtime primitive in
 * `@stwd/shared` so both the API (config validation) and the webhooks dispatcher
 * can consult the same registry. It carries NO http/framework types.
 */

/**
 * A registry of valid webhook event-type names. Seeded with the core event
 * types (which can never be removed); plugins add their declared event names at
 * composition time.
 */
export class WebhookEventRegistry {
  /** core event names — always valid, never removable. */
  private readonly core: ReadonlySet<string>;
  /** plugin-declared event names, keyed for diagnostics by contributing plugin. */
  private readonly pluginEvents = new Map<string, ReadonlySet<string>>();
  /** flattened cache of every currently-valid event name; invalidated on change. */
  private cache: Set<string> | null = null;

  constructor(coreEventTypes: Iterable<string>) {
    this.core = new Set(coreEventTypes);
  }

  /**
   * Register the event-type names a plugin declares. Idempotent per plugin name:
   * re-registering the same plugin replaces its previous declaration (so a
   * recompose does not accumulate stale names). Registering core-overlapping
   * names is harmless (the union already contains them).
   */
  registerPluginEvents(pluginName: string, eventTypes: Iterable<string>): void {
    this.pluginEvents.set(pluginName, new Set(eventTypes));
    this.cache = null;
  }

  /** True when `type` is a core event or any enabled plugin declared it. */
  has(type: string): boolean {
    if (this.core.has(type)) return true;
    return this.all().has(type);
  }

  /** Every currently-valid event name (core ∪ all plugin-declared). */
  all(): ReadonlySet<string> {
    if (this.cache) return this.cache;
    const merged = new Set<string>(this.core);
    for (const names of this.pluginEvents.values()) {
      for (const name of names) merged.add(name);
    }
    this.cache = merged;
    return merged;
  }

  /** Sorted array of every valid event name — for error messages / diagnostics. */
  list(): string[] {
    return [...this.all()].sort();
  }

  /**
   * Diagnostics: which plugin contributed which event names. Core events are not
   * included (they are implicit). Used by the host's "what did plugins
   * contribute" surface.
   */
  describeContributions(): Record<string, string[]> {
    // SEC-192: null-prototype — a plugin literally named "__proto__" assigned
    // through a plain object literal would set the prototype and silently
    // vanish from JSON diagnostics.
    const out: Record<string, string[]> = Object.create(null);
    for (const [plugin, names] of this.pluginEvents) {
      out[plugin] = [...names].sort();
    }
    return out;
  }
}
