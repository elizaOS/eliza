/**
 * Source-scanning gate enforcing that role authority derives from the canonical
 * useRole() context, not ad-hoc flags. Reads the src tree, no runtime.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Role-derivation gate (#12087 Item 24).
 *
 * The UI has exactly one role-gating primitive: `useRole()` / `<RoleGate>`
 * (`hooks/useRole.tsx`, `components/RoleGate.tsx`), populated once by
 * `ShellRoleProvider`. Every other surface must gate through those wrappers, not
 * by importing the raw core rank primitives (`roleRank`, `satisfiesRoleGate`,
 * `ROLE_RANK`, …) and re-deriving a tier ad hoc — that is exactly the
 * fragmentation #9948 / #12087 collapsed.
 *
 * This gate greps authored UI source for direct imports of the core role
 * primitives and fails if any file outside the canonical role-infra allowlist
 * pulls them in. A NEW ad-hoc derivation trips it; the fix is to consume
 * `useRole()` / `<RoleGate>` instead.
 */

const SRC_ROOT = import.meta.dirname;

/** Core role primitives that must only be consumed by the role-infra layer. */
const FORBIDDEN_CORE_ROLE_SYMBOLS = new Set([
  "roleRank",
  "satisfiesRoleGate",
  "hasAtLeastRole",
  "isAdminRank",
  "ROLE_RANK",
  "CANONICAL_ROLE_RANK",
]);

/**
 * The only files allowed to import the raw core role primitives — the canonical
 * `useRole`/`RoleGate` wrappers and the provider that seeds them. Paths are
 * relative to `SRC_ROOT`, POSIX-separated.
 */
const ALLOWLIST = new Set([
  "hooks/useRole.tsx",
  "components/RoleGate.tsx",
  "components/ShellRoleProvider.tsx",
]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__e2e__") {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (
      /\.tsx?$/.test(name) &&
      !name.includes(".test.") &&
      !name.includes(".spec.") &&
      !name.includes(".stories.")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Named imports drawn from `@elizaos/core` in a source file (aliases stripped). */
function coreRoleImports(source: string): string[] {
  const names: string[] = [];
  const importRe =
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@elizaos\/core["']/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop.
  while ((match = importRe.exec(source)) !== null) {
    for (const raw of match[1].split(",")) {
      const name = raw
        .replace(/\btype\b/, "")
        .split(/\bas\b/)[0]
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("role-derivation gate (#12087 Item 24)", () => {
  it("keeps raw core role primitives out of non-role-infra UI source", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const relative = file.slice(SRC_ROOT.length + 1).replace(/\\/g, "/");
      if (ALLOWLIST.has(relative)) continue;
      const imported = coreRoleImports(readFileSync(file, "utf8"));
      for (const name of imported) {
        if (FORBIDDEN_CORE_ROLE_SYMBOLS.has(name)) {
          offenders.push(`${relative} imports ${name} from @elizaos/core`);
        }
      }
    }
    expect(
      offenders,
      `Ad-hoc role derivation detected. Gate via useRole()/<RoleGate> instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("recognizes a violation (self-check on the detector)", () => {
    const sample = `import { roleRank, type RoleGateRole } from "@elizaos/core";`;
    expect(coreRoleImports(sample)).toContain("roleRank");
    expect(coreRoleImports(sample)).toContain("RoleGateRole");
    expect(
      coreRoleImports(sample).some((n) => FORBIDDEN_CORE_ROLE_SYMBOLS.has(n)),
    ).toBe(true);
  });
});
