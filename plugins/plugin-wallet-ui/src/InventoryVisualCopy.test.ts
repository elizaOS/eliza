import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "InventoryView.tsx"),
  "utf8",
);

describe("Inventory visual copy", () => {
  it("keeps RPC provider status free of raw bullet separators", () => {
    expect(source).not.toContain("EVM: ");
    expect(source).not.toContain(" • Solana:");
    expect(source).toContain("RPC providers: EVM ");
  });

  it("keeps the empty wallet market pulse free of paragraph helper copy", () => {
    expect(source).not.toContain(
      '<p className="mt-2 max-w-xl text-sm text-muted">',
    );
  });
});
