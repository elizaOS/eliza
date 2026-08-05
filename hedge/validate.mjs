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

for (const reference of manifest.local_personas) {
  assert.equal(typeof reference, "string", "each persona reference must be a string");
  assert.ok(reference.length > 0, "persona references must not be empty");
  assert.ok(!seen.has(reference), `duplicate persona reference: ${reference}`);
  seen.add(reference);

  const personaPath = resolve(bundleDirectory, reference);
  const bundleRelativePath = relative(bundleDirectory, personaPath);
  assert.ok(
    bundleRelativePath.length > 0 &&
      bundleRelativePath !== ".." &&
      !bundleRelativePath.startsWith(`..${sep}`) &&
      !bundleRelativePath.startsWith(sep),
    `persona reference escapes the bundle: ${reference}`,
  );

  const personaStat = await stat(personaPath);
  assert.ok(personaStat.isFile(), `persona reference is not a file: ${reference}`);

  const personaRealPath = await realpath(personaPath);
  const bundleRealRelativePath = relative(bundleRealDirectory, personaRealPath);
  assert.ok(
    bundleRealRelativePath.length > 0 &&
      bundleRealRelativePath !== ".." &&
      !bundleRealRelativePath.startsWith(`..${sep}`) &&
      !bundleRealRelativePath.startsWith(sep),
    `persona reference resolves outside the bundle: ${reference}`,
  );

  const persona = JSON.parse(await readFile(personaRealPath, "utf8"));
  assert.equal(typeof persona?.persona?.name, "string", `persona name missing: ${reference}`);
  assert.ok(persona.persona.name.trim().length > 0, `persona name empty: ${reference}`);
}

console.log(`Validated ${seen.size} self-contained hedge personas.`);
