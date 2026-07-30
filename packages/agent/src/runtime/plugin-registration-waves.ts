/**
 * Computes maximally parallel plugin registration waves while enforcing every
 * declared dependency before runtime mutation begins.
 */
export interface PluginRegistrationPlanEntry {
  name: string;
  dependencies: readonly string[];
}

export function planPluginRegistrationWaves(
  entries: readonly PluginRegistrationPlanEntry[],
  alreadyRegistered: ReadonlySet<string>,
): string[][] {
  const pending = new Map(entries.map((entry) => [entry.name, entry]));
  const known = new Set([...alreadyRegistered, ...pending.keys()]);
  for (const entry of entries) {
    const missing = entry.dependencies.filter(
      (dependency) => !known.has(dependency),
    );
    if (missing.length > 0) {
      throw new Error(
        `Plugin ${entry.name} has unavailable dependencies: ${missing.join(", ")}`,
      );
    }
  }

  const registered = new Set(alreadyRegistered);
  const waves: string[][] = [];
  while (pending.size > 0) {
    const wave = [...pending.values()]
      .filter((entry) =>
        entry.dependencies.every((dependency) => registered.has(dependency)),
      )
      .map((entry) => entry.name);
    if (wave.length === 0) {
      throw new Error(
        `Plugin dependency cycle: ${[...pending.keys()].join(", ")}`,
      );
    }
    waves.push(wave);
    for (const name of wave) {
      pending.delete(name);
      registered.add(name);
    }
  }
  return waves;
}
