/**
 * Deterministic peer-coherence gate for the spawned-worker Effect prerelease
 * family (#18810). Walks the real module-resolution chain the Smithers worker
 * uses — this plugin → @smthrs/engine → @effect/platform-bun →
 * @effect/platform-node-shared — through Bun's isolated store, and fails when
 * any link's declared dependency or peer range on `effect` (or on another
 * family member) is not satisfied by the version that link actually resolves,
 * or when two links load `effect` from different installed copies. Offline and
 * mock-free: the assertions read the exact manifests the runtime would load,
 * so an invalid lockfile peer resolution fails here instead of as a
 * FiberRefs/module-identity crash inside a spawned worker. The chain is
 * seeded with this plugin's own manifest because the worker script imports
 * `effect` directly, so plugin-level drift against the engine's pins is a
 * failure this gate must catch.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface FamilyManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface ResolvedFamilyManifest extends FamilyManifest {
  entry: string;
}

/** Resolve the installed manifest that `fromFile` can reach through its
 *  nearest node_modules chain. Reading the manifest path directly also covers
 *  packages whose export map intentionally has no root entry point. */
function resolvedManifest(fromFile: string, name: string): ResolvedFamilyManifest {
  let dir = path.dirname(fromFile);
  for (;;) {
    const manifestPath = path.join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifestPath)) {
      const entry = realpathSync(manifestPath);
      const manifest = JSON.parse(readFileSync(entry, 'utf8')) as FamilyManifest;
      if (manifest.name === name) return { ...manifest, entry };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`cannot resolve ${name}'s package.json from ${fromFile}`);
    }
    dir = parent;
  }
}

function entryOf(manifest: ResolvedFamilyManifest): string {
  return manifest.entry;
}

const FAMILY = new Set([
  'effect',
  '@effect/platform-bun',
  '@effect/platform-node-shared',
  '@effect/sql-sqlite-bun',
  '@effect/opentelemetry',
]);

/** Both declaration maps, kept separate so a dependencies range can never be
 *  silently shadowed by a peer range on the same name. */
function declaredEdges(manifest: FamilyManifest): Array<[string, string]> {
  return [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.peerDependencies ?? {}),
  ];
}

describe('spawned-worker Effect family peer coherence (#18810)', () => {
  // The worker resolves from the plugin root (smithers-runtime spawns with
  // cwd=pluginRoot and imports `effect` directly), so the chain is seeded
  // with the plugin's own manifest — plugin→effect and plugin→engine are
  // asserted edges, not assumptions.
  const pluginManifestPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../package.json'
  );
  const plugin: ResolvedFamilyManifest = {
    ...(JSON.parse(readFileSync(pluginManifestPath, 'utf8')) as FamilyManifest),
    entry: pluginManifestPath,
  };
  const chain: ResolvedFamilyManifest[] = [plugin];
  const seen = new Set<string>([plugin.name]);

  // Breadth-first walk of the family edges reachable from the plugin, always
  // resolving from the dependent's own manifest anchor so Bun's isolated-store
  // linkage (including peer placement) is what gets tested. Smithers' own
  // packages are traversed as intermediates (observability carries the
  // opentelemetry edge) but only family edges are asserted.
  for (let index = 0; index < chain.length; index += 1) {
    const dependent = chain[index];
    for (const [name] of declaredEdges(dependent)) {
      if (seen.has(name)) continue;
      const isFamily = FAMILY.has(name);
      if (!isFamily && name !== 'smthrs' && !name.startsWith('@smthrs/')) continue;
      seen.add(name);
      chain.push(resolvedManifest(entryOf(dependent), name));
    }
  }

  test('the worker chain reaches the whole installed family', () => {
    const reachedFamily = [...seen].filter((name) => FAMILY.has(name)).sort();
    expect(reachedFamily).toEqual([...FAMILY].sort());
  });

  test('every chain member loads effect from one single installed copy', () => {
    // Range satisfaction alone cannot catch two coexisting effect copies —
    // the exact FiberRefs/module-identity failure class — so assert that
    // every dependent that declares effect resolves it to the same realpath.
    const copies = new Map<string, string>();
    for (const dependent of chain) {
      if (!declaredEdges(dependent).some(([name]) => name === 'effect')) {
        continue;
      }
      const entry = createRequire(entryOf(dependent)).resolve('effect');
      copies.set(dependent.name, realpathSync(entry));
    }
    expect(copies.size).toBeGreaterThan(0);
    const distinct = new Set(copies.values());
    expect(distinct.size, `multiple effect copies loaded: ${JSON.stringify([...copies])}`).toBe(1);
  });

  for (let index = 0; index < chain.length; index += 1) {
    const dependent = chain[index];
    for (const [name, range] of declaredEdges(dependent)) {
      if (!FAMILY.has(name)) continue;
      test(`${dependent.name}@${dependent.version} → ${name} (${range}) resolves to a satisfying version`, () => {
        // Bun.semver.satisfies is permissive about alias ranges
        // (workspace:/npm:/catalog:), which would make the assertion pass
        // vacuously — fail closed on anything that is not plain semver.
        expect(
          /^[\^~>=<]*\d/.test(range),
          `${dependent.name}'s range for ${name} (${range}) is not plain semver`
        ).toBe(true);
        const resolved = resolvedManifest(entryOf(dependent), name);
        expect(
          Bun.semver.satisfies(resolved.version, range),
          `${name}@${resolved.version} does not satisfy ${dependent.name}'s range ${range}`
        ).toBe(true);
      });
    }
  }
});
