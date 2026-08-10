/**
 * Account components are consumed as a browser-facing package subpath. Keep
 * their selector dependency on the narrow store so importing an account
 * component does not evaluate the broad state barrel and its unrelated runtime
 * modules.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const selectorConsumers = [
  "AccountCard.tsx",
  "AccountCommandTable.tsx",
  "AccountList.tsx",
  "AccountManagementPanel.tsx",
  "AddAccountDialog.tsx",
  "ProviderAccountRow.tsx",
  "ProviderPicker.tsx",
  "RotationStrategyPicker.tsx",
] as const;

describe("account component state imports", () => {
  it.each(selectorConsumers)(
    "%s imports useAppSelector from the browser-safe store",
    (fileName) => {
      const source = readFileSync(
        resolve(import.meta.dirname, fileName),
        "utf8",
      );

      expect(source).toMatch(
        /import\s*\{\s*useAppSelector\s*\}\s*from\s*["']\.\.\/\.\.\/state\/app-store["'];/,
      );
      expect(source).not.toMatch(
        /from\s*["']\.\.\/\.\.\/state(?:\/index(?:\.js)?)?["'];/,
      );
    },
  );
});
