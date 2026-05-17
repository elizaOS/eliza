/**
 * Health-related agent actions exposed by plugin-health.
 *
 * Wave-1 (W1-B) move: `actions/health.ts` and `actions/screen-time.ts` are
 * still owned by app-lifeops because they instantiate `LifeOpsService`
 * directly (`new LifeOpsService(runtime)`) — moving the construction surface
 * into plugin-health would create a circular package dependency since
 * `LifeOpsService` lives in app-lifeops.
 *
 * The pure-domain helpers those actions delegate to (`health-bridge.ts`,
 * `health-connectors.ts`, sleep / circadian / awake-probability inference)
 * have been moved into plugin-health. Wave-2 (W2-A: scenario-named action
 * migration onto `ScheduledTask`) is responsible for the action move +
 * `LifeOpsService` decoupling.
 *
 * For now, app-lifeops continues to register both actions on its own plugin
 * surface. plugin-health exposes no actions of its own at Wave-1.
 */

export const HEALTH_ACTIONS_DEFERRED_TO_WAVE_2 = true as const;
