import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Finds the org.json jar that the host-JVM harnesses compile Android sources against.
// ELIZA_ORG_JSON_JAR names it; ALPHA_JSON_JAR and ELIZA_JSON_JAR are older names still exported by
// callers. Otherwise the Gradle cache copy of org.json:json:20250517 is used when present.
// With CI=true or ELIZA_REQUIRE_JVM_TESTS=1 a missing jar throws instead of letting the test skip.
//
// This is the stleary org.json jar, not Android's libcore JSON: they differ (for example optString
// on JSONObject.NULL returns the fallback here and "null" on Android), so these harnesses do not
// prove Android's coercion behavior.

const VERSION = "20250517";

/** True when JVM harnesses must run rather than skip. */
export const jvmTestsRequired = () =>
  process.env.CI === "true" || process.env.ELIZA_REQUIRE_JVM_TESTS === "1";

const cached = () => {
  const root = path.join(
    os.homedir(),
    ".gradle/caches/modules-2/files-2.1/org.json/json",
    VERSION,
  );
  if (!fs.existsSync(root)) return null;
  for (const hash of fs.readdirSync(root)) {
    const jar = path.join(root, hash, `json-${VERSION}.jar`);
    if (fs.existsSync(jar)) return jar;
  }
  return null;
};

/** @returns {{ jar: string, reason: null } | { jar: null, reason: string }} */
export const resolveOrgJsonJar = () => {
  const named =
    process.env.ELIZA_ORG_JSON_JAR ||
    process.env.ALPHA_JSON_JAR ||
    process.env.ELIZA_JSON_JAR;
  if (named) {
    if (fs.existsSync(named)) return { jar: named, reason: null };
    return missing(`org.json jar not found at ${named}`);
  }
  const jar = cached();
  if (jar) return { jar, reason: null };
  return missing(
    `org.json jar unavailable (set ELIZA_ORG_JSON_JAR or resolve org.json:json:${VERSION} with Gradle)`,
  );
};

/** @param {string} reason */
const missing = (reason) => {
  if (jvmTestsRequired()) throw new Error(reason);
  return { jar: null, reason };
};
