/**
 * plugin.ts — the lean-core + opt-in-plugin contract.
 *
 * steward is a lean open core (auth, wallet/vault, policy, proxy, webhooks) plus
 * opt-in plugins that a host registers onto the app at the composition root. the
 * core never imports a plugin; a plugin contributes routes/middleware through the
 * register seam, so the majority of installs that only want the core never pull a
 * plugin's transitive dependencies (smaller install, smaller supply-chain and
 * audit surface). trading is the first such plugin.
 *
 * `StewardPlugin` is intentionally generic and framework-agnostic here: it carries
 * no hono (or any http-framework) types so `@stwd/shared` keeps zero runtime deps.
 * the concrete app + context types are supplied by `@stwd/api` (see its
 * `StewardApiPlugin` / `StewardAppContext`), which is where the hono `app` and the
 * injected service context are bound. a third-party plugin author depends only on
 * `@stwd/api`'s exported plugin types, not on `@stwd/shared`'s generic shape, but
 * the generic lives here so the contract is owned by the core's type vocabulary.
 *
 * App  = the host application a plugin mounts onto (a hono app in @stwd/api).
 * Ctx  = the injected context the core hands the plugin: the shared service
 *        singletons (db, vault, policy engine, audit writer, ...) and the auth
 *        middleware a plugin needs to gate its own routes. injecting these is what
 *        lets a plugin live in its own package WITHOUT importing the core (no
 *        circular dependency: core does not import plugin, plugin does not import
 *        core).
 */
/**
 * The shape of a single policy rule as seen by a contributed evaluator. A plugin
 * owns a rule `type` that the core's closed {@link PolicyType} union does NOT
 * enumerate, so the contribution sees the rule structurally: a string `type`
 * (the plugin's discriminator), an `enabled` flag, and an opaque `config` bag the
 * evaluator interprets. This mirrors the core {@link PolicyRule} fields WITHOUT
 * narrowing `type` to the core union, so a plugin rule type is representable.
 */
export interface ContributedPolicyRule {
  readonly id: string;
  /** the plugin's rule-type discriminator (NOT a member of the core union). */
  readonly type: string;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
}

/**
 * The verdict a contributed evaluator returns. Structurally identical to the
 * core `PolicyResult` (policyId/type/passed/reason). Defined here — rather than
 * importing the core `PolicyResult` — so this contract stays self-contained in
 * `@stwd/shared`'s type vocabulary; the policy engine treats a returned value as
 * a `PolicyResult` (the shapes are assignable).
 */
export interface ContributedPolicyResult {
  readonly policyId: string;
  readonly type: string;
  readonly passed: boolean;
  readonly reason?: string;
  /**
   * Optional "route to manual approval instead of hard-denying" signal,
   * structurally identical to the engine's internal `ManualApprovalSignal`.
   * ONLY meaningful when `passed === false` (a passing result never needs
   * approval). The engine's registry passthrough forwards this flag ONLY on a
   * non-passing result, so a contributed rule (e.g. `capability-intent`'s
   * `require-approval` effect) can queue an action for human review through the
   * same channel a core rule uses. Absent => hard deny (fail closed).
   */
  readonly requiresManualApproval?: boolean;
}

/**
 * A policy-rule contribution a plugin declares so the core's policy engine can
 * evaluate a rule type the plugin owns (e.g. a venue-specific gate) WITHOUT the
 * core importing the plugin.
 *
 * WIRED in Phase 2b. The plugin host registers each contribution into the policy
 * engine's runtime evaluator registry (fail-closed on a `type` that collides with
 * a core rule type or another plugin's). When `evaluatePolicy` meets a rule whose
 * `type` is not one of the core cases, it consults the registry; the contributed
 * `evaluate` runs and its result is used. Core rule evaluation is untouched.
 *
 * GENERIC over the evaluator context `Ctx`: `@stwd/shared` must not import
 * `@stwd/policy-engine` (that would be a dependency cycle — policy-engine imports
 * shared), so the concrete evaluator context type lives in policy-engine and is
 * bound there. A plugin author binds `Ctx` to the policy engine's exported
 * `EvaluatorContext`. Left unbound, `Ctx` defaults to `unknown` so the contract
 * is usable without the policy engine present.
 */
export interface PolicyRuleContribution<Ctx = unknown> {
  /** the policy `type` discriminator this rule contributes (must be unique). */
  readonly type: string;
  /**
   * evaluate a rule of this contributed `type` against the injected context.
   * MUST be pure with respect to money state (it reads the context the engine
   * supplies and returns a verdict; it reserves/commits nothing). may be async.
   * a thrown error is treated by the engine as a fail-closed deny.
   */
  evaluate(
    rule: ContributedPolicyRule,
    ctx: Ctx,
  ): ContributedPolicyResult | Promise<ContributedPolicyResult>;
  /** optional human-readable description, surfaced in diagnostics. */
  readonly description?: string;
}

/**
 * A database-migration source a plugin contributes so its tables/columns are
 * created when the plugin is enabled, WITHOUT the core owning the plugin's
 * schema.
 *
 * WIRED in Phase 2c. The host applies these via `@stwd/db`'s
 * `runPluginMigrations`, which runs the plugin's drizzle migrations into a
 * SEPARATE, PER-PLUGIN bookkeeping table derived from `id`
 * (`__drizzle_migrations_plugin_<sanitized id>` in the `drizzle` schema). The
 * isolation guarantee is total: a plugin's applied-migrations ledger is NEVER
 * written into or read from the core's `drizzle.__drizzle_migrations` journal, so
 * a plugin owns its schema and CANNOT clobber the core's migration state. The
 * host runs plugin migrations AFTER core migrations (so a plugin may reference
 * core tables via FK) and in `dependsOn` order, at the boot/migrate step only —
 * never implicitly per request.
 */
export interface PluginMigrationSource {
  /**
   * a stable namespace id for the plugin's migrations, e.g. "trading". used to
   * derive the per-plugin bookkeeping table name + advisory-lock key, so a
   * plugin's migration ledger is isolated from the core's and from every other
   * plugin's. MUST be stable across releases (changing it orphans the prior
   * ledger and re-applies every migration). sanitized to a safe SQL identifier
   * by the runner; an id that sanitizes to empty or exceeds the PostgreSQL-safe
   * bound is rejected. The host rejects aliases across its registered plugins.
   */
  readonly id: string;
  /**
   * absolute path to the plugin's OWN drizzle migrations directory — the folder
   * containing the plugin's `*.sql` migrations plus its own `meta/_journal.json`
   * (generated by the plugin's own `drizzle-kit generate`). this is the plugin's
   * schema source of truth; the core's `packages/db/drizzle` folder is never
   * consulted for a plugin run.
   */
  readonly migrationsFolder: string;
}

/**
 * An adapter contribution a plugin registers into the core's adapter registry
 * (mirrors `packages/adapters` categories) so a plugin can supply a real
 * provider integration (a concrete swap/earn/onramp/.../exchange adapter).
 *
 * WIRED in Phase 2d. The host registers each contribution into the core's
 * {@link AdapterRegistry} via its existing `register(category, provider, adapter)`
 * seam, in `dependsOn` order, FAIL-CLOSED on a `(category, provider)` collision
 * with another plugin's contribution (the host never silently overwrites a real
 * money-route adapter — see the host's conflict detection). The registry's own
 * fail-closed-in-production RESOLUTION is untouched: a contributed adapter is
 * selected exactly as a core-registered one would be (env `STEWARD_<CAT>_ADAPTER`
 * names the provider, or a single registered provider is used without env
 * disambiguation).
 *
 * STRUCTURAL on purpose: `@stwd/shared` must NOT import `@stwd/adapters`
 * (`@stwd/adapters` depends on `@stwd/shared`, so importing the concrete
 * per-category adapter types here would create a dependency CYCLE). The category
 * is therefore a plain `string` (assignable to the registry's `AdapterCategory`,
 * validated by the host) and the concrete adapter instance is typed `unknown` —
 * the host casts it to the registry's per-category type at the api boundary,
 * where `@stwd/adapters` is a legitimate dependency.
 */
export interface AdapterContribution {
  /**
   * the adapter category this contribution targets, e.g. "swap". a plain string
   * (not the adapters' `AdapterCategory` union) to avoid a shared->adapters
   * cycle; the host validates it is a known category and casts, fail-closed on
   * an unknown category.
   */
  readonly category: string;
  /** the provider name this contribution registers under (must be non-empty). */
  readonly provider: string;
  /**
   * the concrete adapter instance to register under `(category, provider)`.
   * typed `unknown` at the shared layer to avoid a shared->adapters cycle (the
   * concrete per-category adapter types live in `@stwd/adapters`); the host
   * casts it to the registry's expected per-category type when it calls
   * `adapterRegistry.register(...)`.
   */
  readonly adapter: unknown;
}

export interface LoginPlugin<App = unknown, Ctx = unknown, EvalCtx = unknown> {
  /** stable identifier for the plugin, e.g. "trading". used in logs/diagnostics. */
  readonly name: string;
  /**
   * optional semantic version of the plugin. surfaced in the host's diagnostics
   * so an operator can see which plugin versions a deploy composed.
   */
  readonly version?: string;
  /**
   * names of other plugins that must be registered BEFORE this one. the host
   * topologically orders plugins by this graph and FAILS CLOSED (throws) on a
   * missing or cyclic dependency — a plugin never silently registers against a
   * half-built dependency.
   */
  readonly dependsOn?: readonly string[];
  /**
   * mount the plugin's routes + middleware onto `app`, using the injected `ctx`
   * for shared services and auth gates. may be async (e.g. to lazily resolve a
   * provider). called once, at the composition root, after the core is built.
   *
   * OPTIONAL as of Phase 2: a plugin may contribute ONLY declaratively (via the
   * contribution points below) without mounting any route/middleware. the
   * trading plugin still uses `register` for back-compat.
   */
  register?(app: App, ctx: Ctx): void | Promise<void>;

  // ── declarative contribution points (all optional) ──────────────────────────

  /**
   * webhook event-type names this plugin emits. the host merges these into the
   * runtime registry of valid event types (core union ∪ plugin-declared) so the
   * webhook dispatcher/config validation accepts a plugin's event without the
   * core's closed union having to know about it ahead of time.
   *
   * WIRED in Phase 2a — this is the keystone contribution point proven
   * end-to-end by the trading plugin.
   */
  readonly webhookEvents?: readonly string[];

  /**
   * policy rules this plugin contributes. WIRED in Phase 2b: the host registers
   * each into the policy engine's runtime evaluator registry (fail-closed on a
   * `type` collision with a core rule type or another plugin's). The policy
   * engine then evaluates a rule of a contributed `type` via the contribution's
   * `evaluate`. `EvalCtx` is bound by the concrete app plugin type (in
   * `@stwd/api`) to the policy engine's `EvaluatorContext`.
   */
  readonly policyRules?: readonly PolicyRuleContribution<EvalCtx>[];

  /**
   * database migrations this plugin contributes. WIRED in Phase 2c: the host
   * applies these via `@stwd/db`'s `runPluginMigrations` into a per-plugin
   * namespaced bookkeeping table (`__drizzle_migrations_plugin_<id>`), totally
   * isolated from the core's `drizzle.__drizzle_migrations` journal, AFTER core
   * migrations and in `dependsOn` order, at the boot/migrate step only.
   */
  readonly migrations?: PluginMigrationSource;

  /**
   * adapter integrations this plugin contributes. WIRED in Phase 2d: the host
   * registers each into the core's adapter registry via its existing
   * `register(category, provider, adapter)` seam, in `dependsOn` order,
   * FAIL-CLOSED on a `(category, provider)` collision with another plugin's
   * contribution (never silently overwrites a real money-route adapter). The
   * registry's fail-closed-in-production RESOLUTION is untouched.
   */
  readonly adapters?: readonly AdapterContribution[];
}
