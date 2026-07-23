/**
 * Verifies benchmark false-positive exceptions remain bound to one source path
 * and one non-secret program identifier instead of weakening secret scanning.
 */

import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

interface Allowlist {
  description?: string;
  condition?: string;
  paths?: string[];
  regexTarget?: string;
  regexes?: string[];
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const config = Bun.TOML.parse(
  await Bun.file(`${REPOSITORY_ROOT}/.gitleaks.toml`).text(),
) as { allowlists?: Allowlist[] };

const cases = [
  {
    description:
      "MMLU max-token runner arguments (program identifiers, not credentials)",
    path: "packages/benchmarks/standard/mmlu.py",
    line: [
      "max",
      "_tokens=args.",
      "max",
      "_tokens, include_edge_",
      "scenarios=args.expand_",
      "scenarios",
    ].join(""),
  },
  {
    description: "Benchmark estimated-token publication warning identifier",
    path: "packages/benchmarks/orchestrator/tests/test_latest_snapshots.py",
    line: [
      '"estimated_',
      "token_metrics:",
      "prompt_chars_",
      'div_4" in publication_',
      "warnings",
    ].join(""),
  },
] as const;

for (const fixture of cases) {
  test(`${fixture.description} stays narrowly scoped`, () => {
    const allowlist = config.allowlists?.find(
      ({ description }) => description === fixture.description,
    );

    expect(allowlist).toBeDefined();
    expect(allowlist?.condition).toBe("AND");
    expect(allowlist?.regexTarget).toBe("line");
    expect(allowlist?.paths).toHaveLength(1);
    expect(allowlist?.regexes).toHaveLength(1);

    const pathPattern = new RegExp(allowlist?.paths?.[0] ?? "");
    const linePattern = new RegExp(allowlist?.regexes?.[0] ?? "");
    expect(pathPattern.test(fixture.path)).toBe(true);
    expect(linePattern.test(fixture.line)).toBe(true);
    expect(pathPattern.test("packages/core/src/config.ts")).toBe(false);
    expect(linePattern.test('api_key = "live-production-credential"')).toBe(
      false,
    );
  });
}
