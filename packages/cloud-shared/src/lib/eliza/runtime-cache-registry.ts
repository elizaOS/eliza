/**
 * Cache and OAuth modules avoid importing runtime-factory (breaks circular imports).
 * runtime-factory calls registerRuntimeCacheActions after the factory singleton exists.
 */

type RuntimeCacheActions = {
  invalidateRuntime: (agentId: string) => Promise<boolean>;
  invalidateByOrganization: (organizationId: string) => Promise<number>;
};

let actions: RuntimeCacheActions | null = null;

export function registerRuntimeCacheActions(next: RuntimeCacheActions): void {
  actions = next;
}

export async function invalidateRuntimeFromRegistry(agentId: string): Promise<boolean> {
  const a = actions;
  if (!a) {
    throw new Error(
      "[RuntimeCacheRegistry] registerRuntimeCacheActions was not called (runtime-factory not loaded)",
    );
  }
  return a.invalidateRuntime(agentId);
}

export async function invalidateOrganizationRuntimesFromRegistry(
  organizationId: string,
): Promise<number> {
  const a = actions;
  if (!a) {
    throw new Error(
      "[RuntimeCacheRegistry] registerRuntimeCacheActions was not called (runtime-factory not loaded)",
    );
  }
  return a.invalidateByOrganization(organizationId);
}
