/** Applies the CEF partition fix to exact pinned Electrobun source variants. */
import { createHash } from "node:crypto";

// Bun's pinned dependency patch widens Pointer for Bun 1.4 before postinstall.
// Accept only the upstream file or that exact patch result, never arbitrary edits.
const variants = new Map([
  [
    "8c172878fd77bd2119d7958a1c2c8280bf9642c78abf8a1cbcb67fa3b03226cf",
    "583aa653d89eb01d55e9ee5b3f90c021e924827c811d119a2bf6100432e938bd",
  ],
  [
    "f48dda33323ed599690ae25d663ea4dd6ce0d8c965d91b6893de58598c402e8c",
    "793897f84aa7aba7e6ee932f136b8f0f519aa9d829ad974dc92be0b09af4df21",
  ],
]);
const digest = (source) => createHash("sha256").update(source).digest("hex");

export function patchElectrobunBrowserWindowSource(original) {
  const before = digest(original);
  if ([...variants.values()].includes(before)) return original;
  const expected = variants.get(before);
  if (!expected) {
    throw new Error(
      `Refusing to patch unexpected BrowserWindow.ts (${before}).`,
    );
  }
  const patched = original
    .replace(
      "\tviewsRoot: string | null;\n\trenderer:",
      "\tviewsRoot: string | null;\n\tpartition?: string | null;\n\trenderer:",
    )
    .replace(
      "\t\t\tviewsRoot: this.viewsRoot,\n\t\t\t// frame:",
      "\t\t\tviewsRoot: this.viewsRoot,\n\t\t\tpartition: partition || null,\n\t\t\t// frame:",
    )
    .replace(
      "\t\tactivate,\n\t}: Partial<WindowOptionsType<T>>) {",
      "\t\tactivate,\n\t\tpartition,\n\t}: Partial<WindowOptionsType<T>>) {",
    );
  if (digest(patched) !== expected) {
    throw new Error("Patched BrowserWindow.ts hash mismatch.");
  }
  return patched;
}
