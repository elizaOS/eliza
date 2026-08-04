/**
 * Normalizes Capacitor's generated Android settings so tracked output resolves
 * npm packages at Gradle runtime instead of embedding Bun-store versions and
 * installation hashes from the machine that last ran `cap sync`.
 */
import fs from "node:fs";

const RESOLVER = `String resolveNodePackageDir(String packageName) {
    def output = providers.exec {
        commandLine 'node', '--print', "require('node:path').dirname(require.resolve('\${packageName}/package.json'))"
    }.standardOutput.asText.get().trim()
    if (!output) {
        throw new GradleException("Unable to resolve npm package: \${packageName}")
    }
    return output
}
`;

function splitPackagePath(generatedPath) {
  const marker = "/node_modules/";
  const packagePath = generatedPath.slice(
    generatedPath.lastIndexOf(marker) + marker.length,
  );
  const segments = packagePath.split("/");
  const packageName = segments[0].startsWith("@")
    ? segments.splice(0, 2).join("/")
    : segments.shift();
  return { packageName, childPath: segments.join("/") };
}

export function normalizeCapacitorSettings(contents) {
  let normalized = contents.replace(
    /new File\('([^']*\/node_modules\/[^']+)'\)/g,
    (expression, generatedPath) => {
      const { packageName, childPath } = splitPackagePath(generatedPath);
      if (!packageName) return expression;
      return childPath
        ? `new File(resolveNodePackageDir('${packageName}'), '${childPath}')`
        : `new File(resolveNodePackageDir('${packageName}'))`;
    },
  );
  if (
    normalized.includes("resolveNodePackageDir(") &&
    !normalized.includes("String resolveNodePackageDir")
  ) {
    normalized = `${RESOLVER}\n${normalized}`;
  }
  return normalized;
}

export function normalizeCapacitorSettingsFile(settingsPath) {
  const current = fs.readFileSync(settingsPath, "utf8");
  const normalized = normalizeCapacitorSettings(current);
  if (normalized !== current) fs.writeFileSync(settingsPath, normalized);
  return normalized !== current;
}
