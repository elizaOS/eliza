/**
 * Owner surfaces withheld at registration so one store owns each owner domain.
 *
 * A host whose own app store owns alarms, reminders or undated to-dos names
 * them in ELIZA_NATIVE_OWNED_DOMAINS; the matching LifeOps owner umbrellas and
 * their promoted subactions are then never registered, so neither the planner
 * nor the deterministic routing heuristics can pick them. The rest of the
 * personal assistant (scheduled tasks, briefs, automations) stays loaded.
 *
 * Independently, when the personal assistant is in the load set it owns agent
 * to-dos through OWNER_TODOS, so plugin-todos' TODO action and CURRENT_TODOS
 * provider are withheld (its view stays) and only one to-do store is offered.
 */
import type { Plugin } from "@elizaos/core";
import {
  type NativeOwnedDomain,
  nativeOwnedDomains,
} from "@elizaos/plugin-assistant";

export const PERSONAL_ASSISTANT_PLUGIN_NAME =
  "@elizaos/plugin-personal-assistant";
const TODOS_PLUGIN_NAMES: ReadonlySet<string> = new Set([
  "todos",
  "@elizaos/plugin-todos",
]);
const TODOS_ACTION_NAME = "TODO";
const TODOS_PROVIDER_NAME = "CURRENT_TODOS";

const OWNER_SURFACE_BY_DOMAIN: Record<NativeOwnedDomain, string> = {
  alarms: "OWNER_ALARMS",
  reminders: "OWNER_REMINDERS",
  todos: "OWNER_TODOS",
};

export type NativeOwnedSurfacePolicy = {
  domains: ReadonlySet<NativeOwnedDomain>;
  personalAssistantLoaded: boolean;
};

export function nativeOwnedSurfacePolicy(
  pluginNames: ReadonlySet<string>,
  env?: Record<string, string | undefined>,
): NativeOwnedSurfacePolicy {
  return {
    domains: env ? nativeOwnedDomains(env) : nativeOwnedDomains(),
    personalAssistantLoaded: pluginNames.has(PERSONAL_ASSISTANT_PLUGIN_NAME),
  };
}

function isOwnerSurface(actionName: string, ownerName: string): boolean {
  return actionName === ownerName || actionName.startsWith(`${ownerName}_`);
}

/**
 * Return `plugin` without the surfaces the policy withholds. The original
 * descriptor is never mutated; an unaffected plugin is returned as is.
 */
export function withholdNativeOwnedSurfaces(
  plugin: Plugin,
  policy: NativeOwnedSurfacePolicy,
): Plugin {
  const owners = [...policy.domains].map(
    (domain) => OWNER_SURFACE_BY_DOMAIN[domain],
  );
  const todosPlugin = TODOS_PLUGIN_NAMES.has(plugin.name);
  const withholdTodos =
    todosPlugin &&
    (policy.personalAssistantLoaded || policy.domains.has("todos"));
  const keepAction = (name: string) =>
    !owners.some((owner) => isOwnerSurface(name, owner)) &&
    !(withholdTodos && isOwnerSurface(name, TODOS_ACTION_NAME));
  const actions = plugin.actions?.filter((action) => keepAction(action.name));
  const providers = withholdTodos
    ? plugin.providers?.filter(
        (provider) => provider.name !== TODOS_PROVIDER_NAME,
      )
    : plugin.providers;
  if (
    actions?.length === plugin.actions?.length &&
    providers?.length === plugin.providers?.length
  )
    return plugin;
  return { ...plugin, actions, providers };
}
