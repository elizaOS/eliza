/**
 * Validates the hedge-dna bundle: persona JSON stays self-contained and named,
 * and DNA continuity files listed in the manifest exist and are non-empty.
 */
import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const bundleDirectory = dirname(fileURLToPath(import.meta.url));

async function assertInsideBundle(bundleDir, bundleRealDir, reference, label) {
  assert.equal(typeof reference, "string", `${label} reference must be a string`);
  assert.ok(reference.length > 0, `${label} references must not be empty`);

  const targetPath = resolve(bundleDir, reference);
  const bundleRelativePath = relative(bundleDir, targetPath);
  assert.ok(
    bundleRelativePath.length > 0 &&
      bundleRelativePath !== ".." &&
      !bundleRelativePath.startsWith(`..${sep}`) &&
      !bundleRelativePath.startsWith(sep),
    `${label} reference escapes the bundle: ${reference}`,
  );

  const targetStat = await stat(targetPath);
  assert.ok(targetStat.isFile(), `${label} reference is not a file: ${reference}`);

  const targetRealPath = await realpath(targetPath);
  const bundleRealRelativePath = relative(bundleRealDir, targetRealPath);
  assert.ok(
    bundleRealRelativePath.length > 0 &&
      bundleRealRelativePath !== ".." &&
      !bundleRealRelativePath.startsWith(`..${sep}`) &&
      !bundleRealRelativePath.startsWith(sep),
    `${label} reference resolves outside the bundle: ${reference}`,
  );

  return targetRealPath;
}

/**
 * Validate the hedge-dna bundle at `root` (defaults to this package directory).
 * @param {{ root?: string, quiet?: boolean }} [options]
 * @returns {Promise<{ personas: number, dna: number, personaName: string, modes: string[] }>}
 */
export async function validateBundle(options = {}) {
  const root = options.root ?? bundleDirectory;
  const quiet = options.quiet === true;
  const bundleRealDirectory = await realpath(root);
  const manifestPath = resolve(root, "index.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.ok(Array.isArray(manifest.local_personas), "local_personas must be an array");
  assert.ok(manifest.local_personas.length > 0, "local_personas must not be empty");

  const seen = new Set();
  let personaName = "";
  let modes = [];

  for (const reference of manifest.local_personas) {
    assert.ok(!seen.has(reference), `duplicate persona reference: ${reference}`);
    seen.add(reference);

    const personaRealPath = await assertInsideBundle(
      root,
      bundleRealDirectory,
      reference,
      "persona",
    );
    const persona = JSON.parse(await readFile(personaRealPath, "utf8"));
    assert.equal(typeof persona?.persona?.name, "string", `persona name missing: ${reference}`);
    assert.ok(persona.persona.name.trim().length > 0, `persona name empty: ${reference}`);
    assert.ok(
      persona.modes || persona.lineage,
      `hybrid persona should declare modes or lineage: ${reference}`,
    );
    personaName = persona.persona.name.trim();
    modes = persona.modes ? Object.keys(persona.modes) : Array.isArray(manifest.modes) ? manifest.modes : [];
  }

  const dnaRefs = Array.isArray(manifest.dna) ? manifest.dna : [];
  const dnaSeen = new Set();
  for (const reference of dnaRefs) {
    assert.ok(!dnaSeen.has(reference), `duplicate dna reference: ${reference}`);
    dnaSeen.add(reference);

    const dnaRealPath = await assertInsideBundle(root, bundleRealDirectory, reference, "dna");
    const body = await readFile(dnaRealPath, "utf8");
    assert.ok(body.trim().length > 0, `dna file empty: ${reference}`);
    assert.ok(body.includes("#"), `dna file should be markdown with a heading: ${reference}`);
  }

  if (!quiet) {
    console.log(
      `Validated ${seen.size} hedge-dna persona(s) and ${dnaSeen.size} DNA continuity file(s).`,
    );
  }

  return {
    personas: seen.size,
    dna: dnaSeen.size,
    personaName,
    modes,
  };
}

const isMain =
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => process.argv[1])) ===
    (await realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url)));

if (isMain) {
  await validateBundle();
}
