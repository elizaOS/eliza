/** Verifies the repository actionlint configuration narrows its GitHub concurrency queue compatibility exception to the stale-schema diagnostic. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const configPath = join(repoRoot, ".github", "actionlint.yaml");

type ActionlintConfig = {
  paths?: Record<string, { ignore?: string[] }>;
};

describe("actionlint concurrency queue compatibility", () => {
  const config = Bun.YAML.parse(
    readFileSync(configPath, "utf8"),
  ) as ActionlintConfig;

  test.each([".github/workflows/*.yml", ".github/workflows/*.yaml"])(
    "ignores only the stale queue schema error for %s",
    (workflowGlob) => {
      const ignorePatterns = config.paths?.[workflowGlob]?.ignore ?? [];
      const queueDiagnostic =
        'unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"';
      const unrelatedInvalidKey =
        'unexpected key "limit" for "concurrency" section. expected one of "cancel-in-progress", "group"';

      expect(
        ignorePatterns.some((pattern) =>
          new RegExp(pattern).test(queueDiagnostic),
        ),
      ).toBeTrue();
      expect(
        ignorePatterns.every(
          (pattern) => !new RegExp(pattern).test(unrelatedInvalidKey),
        ),
      ).toBeTrue();
    },
  );
});
