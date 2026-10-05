/** Makes Electrobun's native callbacks accept Bun 1.4 `cstring` callback arguments. */

import fs from "node:fs";
import path from "node:path";

const NATIVE_SOURCE = path.join("api", "bun", "proc", "native.ts");
const HELPER_NAME = "elizaCallbackString";
const CALLBACK_ARGUMENTS = [
  "filePath",
  "urlPtr",
  "acceleratorPtr",
  "_eventName",
  "_detail",
  "msg",
  "action",
];
const CALLBACK_CSTRING_RE = new RegExp(
  `new CString\\((${CALLBACK_ARGUMENTS.join("|")})(?: as unknown as Pointer)?\\)`,
  "g",
);
const HELPER_SOURCE = `
// eliza: Bun 1.4 delivers FFIType.cstring JSCallback arguments as JS strings
// (or null), and \`new CString(string)\` throws "ptr must be a number". Several
// of these callbacks have no try/catch, so a tray, menu, shortcut or deep-link
// event would otherwise kill the main process.
function ${HELPER_NAME}(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "bigint") {
		return value ? new CString(Number(value) as Pointer).toString() : "";
	}
	return String(value);
}
`;

function nativeCandidates(packageRoot, fileSystem) {
  const candidates = [path.join(packageRoot, "dist", NATIVE_SOURCE)];
  for (const entry of fileSystem.readdirSync(packageRoot, {
    withFileTypes: true,
  })) {
    if (entry.isDirectory() && entry.name.startsWith("dist-")) {
      candidates.push(path.join(packageRoot, entry.name, NATIVE_SOURCE));
    }
  }
  return candidates.filter((candidate) => fileSystem.existsSync(candidate));
}

/**
 * Electrobun 1.18.1 converts every `FFIType.cstring` JSCallback argument with
 * `new CString(arg)`, which assumes a raw pointer. Under Bun 1.4 the argument
 * is already a string, so webview events are dropped and uncaught throws in
 * the tray, application-menu, context-menu, global-shortcut, URL-open and
 * MIME callbacks terminate the packaged app. Patch the shared source and any
 * platform core downloaded by the CLI. An upstream shape change fails closed.
 */
export function hardenElectrobunCallbackStrings(packageRoot, fileSystem = fs) {
  const candidates = nativeCandidates(packageRoot, fileSystem);
  const canonical = path.join(packageRoot, "dist", NATIVE_SOURCE);
  if (!candidates.includes(canonical)) {
    throw new Error(
      `[electrobun-callback-strings] required native source is missing: ${canonical}`,
    );
  }

  const changed = [];
  for (const candidate of candidates) {
    const source = fileSystem.readFileSync(candidate, "utf8");
    if (source.includes(`function ${HELPER_NAME}(`)) {
      if ((source.match(CALLBACK_CSTRING_RE)?.length ?? 0) > 0) {
        throw new Error(
          `[electrobun-callback-strings] partially patched callbacks in ${candidate}`,
        );
      }
      continue;
    }
    const replacements = source.match(CALLBACK_CSTRING_RE)?.length ?? 0;
    if (replacements === 0) {
      throw new Error(
        `[electrobun-callback-strings] cannot find callback cstring conversions in ${candidate}`,
      );
    }
    const hardened = `${source.replace(
      CALLBACK_CSTRING_RE,
      `${HELPER_NAME}($1)`,
    )}${HELPER_SOURCE}`;
    fileSystem.writeFileSync(candidate, hardened);
    changed.push(candidate);
  }
  return changed;
}
