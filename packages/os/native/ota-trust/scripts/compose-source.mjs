import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function inventory(directory, prefix = "") {
  const result = new Map();
  for (const item of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + item.name;
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) {
      for (const [name, bytes] of inventory(absolute, `${relative}/`))
        result.set(name, bytes);
    } else if (item.isFile()) result.set(relative, fs.readFileSync(absolute));
    else throw new Error("Unexpected OTA source entry");
  }
  return result;
}

/** Compose an admitted shared source tree with a host policy and compatibility tests.
 * The caller admits its reviewed source pin before calling. Every input byte is
 * content-addressed and rechecked on cache reuse; no mutable hard links are used.
 */
export function composeTrustSource({
  sharedSource,
  hostPolicy,
  testDirectory,
  cacheDirectory,
}) {
  // runtimeInventoryHeader and runtimeExcludedAgentDirectories must equal the
  // format and excludedAgentDirectories the host passes to
  // stageAndroidRuntimeInventory; schema 2 added the exclusions.
  const excluded = hostPolicy?.runtimeExcludedAgentDirectories;
  if (
    !hostPolicy ||
    Object.keys(hostPolicy).sort().join(",") !==
      "cohortDomain,package,product,runtimeExcludedAgentDirectories,runtimeInventoryHeader,schema" ||
    hostPolicy.schema !== 2 ||
    !Array.isArray(excluded) ||
    new Set(excluded).size !== excluded.length ||
    !excluded.every(
      (value) =>
        typeof value === "string" &&
        /^[A-Za-z0-9_@.+-]+(\/[A-Za-z0-9_@.+-]+)*$/.test(value) &&
        value.split("/").every((part) => part !== "." && part !== ".."),
    ) ||
    Object.entries(hostPolicy).some(
      ([key, value]) =>
        key !== "schema" &&
        key !== "runtimeExcludedAgentDirectories" &&
        (typeof value !== "string" || !value.trim()),
    )
  )
    throw new Error("Invalid OTA host build policy");
  const encoded = Buffer.from(JSON.stringify(hostPolicy)).toString("base64url");
  const expected = inventory(sharedSource);
  if (testDirectory)
    for (const item of fs
      .readdirSync(testDirectory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (!item.name.endsWith("_test.go")) continue;
      if (!item.isFile() || expected.has(item.name))
        throw new Error("Invalid or colliding OTA compatibility test");
      expected.set(
        item.name,
        fs.readFileSync(path.join(testDirectory, item.name)),
      );
    }
  const digest = createHash("sha256");
  for (const bytes of [
    Buffer.from(encoded),
    ...[...expected]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([name, bytes]) => [Buffer.from(name), bytes]),
  ])
    digest.update(`${bytes.length}:`).update(bytes);
  const source = path.join(path.resolve(cacheDirectory), digest.digest("hex"));
  fs.mkdirSync(cacheDirectory, { recursive: true });
  if (!fs.existsSync(source)) {
    const temporary = fs.mkdtempSync(path.join(cacheDirectory, ".compose-"));
    try {
      for (const [name, bytes] of expected) {
        const destination = path.join(temporary, name);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes);
      }
      try {
        fs.renameSync(temporary, source);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  if (!fs.lstatSync(source).isDirectory())
    throw new Error("Invalid OTA source cache");
  const actual = inventory(source);
  if (
    actual.size !== expected.size ||
    [...expected].some(
      ([name, bytes]) =>
        !actual.has(name) || hash(bytes) !== hash(actual.get(name)),
    )
  )
    throw new Error("Composed OTA source inventory mismatch");
  return {
    source,
    ldflags: `-X=github.com/elizaOS/eliza/packages/os/native/ota-trust.compiledHostPolicyBase64=${encoded}`,
  };
}
