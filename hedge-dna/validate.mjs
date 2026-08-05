/**
 * Validates the hedge-dna bundle: persona JSON stays self-contained and named,
 * and DNA continuity files listed in the manifest exist and are non-empty.
 */
import assert from "node:assert/strict";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const bundleRealDirectory = await realpath(bundleDirectory);
const manifestPath = resolve(bundleDirectory, "index.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

assert.ok(Array.isArray(manifest.local_personas), "local_personas must be an array");
assert.ok(manifest.local_personas.length > 0, "local_personas must not be empty");

const seen = new Set();

async function assertInsideBundle(reference, label) {
  assert.equal(typeof reference, "string", `${label} reference must be a string`);
  assert.ok(reference.length > 0, `${label} references must not be empty`);

  const targetPath = resolve(bundleDirectory, reference);
  const bundleRelativePath = relative(bundleDirectory, targetPath);
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
  const bundleRealRelativePath = relative(bundleRealDirectory, targetRealPath);
  assert.ok(
    bundleRealRelativePath.length > 0 &&
      bundleRealRelativePath !== ".." &&
      !bundleRealRelativePath.startsWith(`..${sep}`) &&
      !bundleRealRelativePath.startsWith(sep),
    `${label} reference resolves outside the bundle: ${reference}`,
  );

  return targetRealPath;
}

for (const reference of manifest.local_personas) {
  assert.ok(!seen.has(reference), `duplicate persona reference: ${reference}`);
  seen.add(reference);

  const personaRealPath = await assertInsideBundle(reference, "persona");
  const persona = JSON.parse(await readFile(personaRealPath, "utf8"));
  assert.equal(typeof persona?.persona?.name, "string", `persona name missing: ${reference}`);
  assert.ok(persona.persona.name.trim().length > 0, `persona name empty: ${reference}`);
  assert.ok(persona.modes || persona.lineage, `hybrid persona should declare modes or lineage: ${reference}`);
}

const dnaRefs = Array.isArray(manifest.dna) ? manifest.dna : [];
const dnaSeen = new Set();
for (const reference of dnaRefs) {
  assert.ok(!dnaSeen.has(reference), `duplicate dna reference: ${reference}`);
  dnaSeen.add(reference);

  const dnaRealPath = await assertInsideBundle(reference, "dna");
  const body = await readFile(dnaRealPath, "utf8");
  assert.ok(body.trim().length > 0, `dna file empty: ${reference}`);
  assert.ok(body.includes("#"), `dna file should be markdown with a heading: ${reference}`);
}

console.log(
  `Validated ${seen.size} hedge-dna persona(s) and ${dnaSeen.size} DNA continuity file(s).`,
);
