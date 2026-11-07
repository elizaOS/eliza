/**
 * Runs the real `run:` blocks of the staging grant-code mint workflow in bash.
 * A fake `bun` on PATH records each mint argv and echoes the sealer's stdin, so
 * no database, pepper or key is touched. Each recorded argv goes through the
 * real `parseMintOptions`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MintOptions,
  parseMintOptions,
} from "./mint-subscription-grant-codes";

type Step = { name?: string; run?: string; env?: Record<string, string> };
const workflow = Bun.YAML.parse(
  readFileSync(
    new URL(
      "../../../../.github/workflows/cloud-staging-mint-grant-codes.yml",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  on: {
    workflow_dispatch: {
      inputs: Record<string, { default?: string | boolean }>;
    };
  };
  jobs: Record<string, { steps: Step[] }>;
};
const inputs = workflow.on.workflow_dispatch.inputs;
const stepRun = (job: string, name: string) => {
  const run = workflow.jobs[job]?.steps.find((step) => step.name === name)?.run;
  if (!run) throw new Error(`missing step ${job}/${name}`);
  return run;
};
const admission = stepRun(
  "admission",
  "Reject untrusted source and malformed inputs",
);
const mintAndSeal = stepRun("mint", "Mint and seal codes");

const root = mkdtempSync(join(tmpdir(), "staging-mint-workflow-"));
const bin = join(root, "bin");
const log = join(root, "argv.log");
Bun.spawnSync(["mkdir", "-p", bin]);
writeFileSync(
  join(bin, "bun"),
  `#!/usr/bin/env bash
if [[ " $* " == *" seal "* ]]; then cat; exit 0; fi
if [[ "$*" == *mint-subscription-grant-codes.ts* ]]; then
  shift 2
  printf '%s\\0' "$@" >> "$ARGV_LOG"; printf '\\n' >> "$ARGV_LOG"
  echo FAKE-CODE
fi
`,
);
chmodSync(join(bin, "bun"), 0o755);
// The admission check needs GNU date (ubuntu-24.04); macOS ships BSD date.
const gnuDate = Bun.which("gdate");
if (process.platform === "darwin" && gnuDate)
  symlinkSync(gnuDate, join(bin, "date"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const COMMIT = "a".repeat(40);
/** The environment GitHub builds when every input keeps its default. */
const defaults = Object.fromEntries(
  Object.entries(inputs).map(([name, input]) => [
    name,
    String(input.default ?? ""),
  ]),
);
const environment = (overrides: Record<string, string>) => {
  const value = { ...defaults, ...overrides };
  return {
    PATH: `${bin}:${process.env.PATH}`,
    ARGV_LOG: log,
    EXPECTED_COMMIT: COMMIT,
    CHECKED_OUT_COMMIT: COMMIT,
    SOURCE_REF: "refs/heads/staging",
    SINGLE_USE_COUNT: value.single_use_count,
    SINGLE_USE_LABEL: value.single_use_label,
    SHARED_MAX: value.shared_max_redemptions,
    SHARED_LABEL: value.shared_label,
    FAMILY: value.family,
    PLAN: value.plan,
    DURATION_DAYS: value.duration_days,
    DURATION_MONTHS: value.duration_months,
    REQUIRES_NO_PAID_PLAN: value.requires_no_paid_plan,
    EXPIRES_AT: value.expires_at,
  };
};
const bash = (script: string, env: Record<string, string>) =>
  Bun.spawnSync(["bash", "-e", "-c", script], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

function admit(overrides: Record<string, string> = {}) {
  const result = bash(admission, environment(overrides));
  return { ok: result.exitCode === 0, output: result.stdout.toString() };
}

function mint(overrides: Record<string, string> = {}): {
  options: MintOptions[];
  envelope: string;
} {
  writeFileSync(log, "");
  const result = bash(mintAndSeal, environment(overrides));
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const options = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => parseMintOptions(line.split("\0").filter(Boolean)));
  const envelope = readFileSync(
    join(root, "test-results/cloud-staging-mint/grant-codes.envelope.json"),
    "utf8",
  );
  return { options, envelope };
}

describe("staging grant-code mint workflow", () => {
  test("defaults mint exactly what the workflow minted before these inputs", () => {
    expect(admit().ok).toBe(true);
    const { options, envelope } = mint();
    // The argv the workflow passed before family/plan/months/expiry inputs.
    expect(options).toEqual([
      parseMintOptions([
        "--count",
        "5",
        "--max-redemptions",
        "1",
        "--duration-days",
        "183",
        "--label",
        "alpha-staging-qa",
      ]),
      parseMintOptions([
        "--count",
        "1",
        "--max-redemptions",
        "50",
        "--duration-days",
        "183",
        "--label",
        "alpha-staging-shared",
      ]),
    ]);
    expect(options[0]).toMatchObject({
      family: "alpha_phone",
      planKey: "plus_monthly",
      requiresNoPaidPlan: false,
      expiresAt: null,
    });
    expect(envelope).toBe(
      "# alpha-staging-qa: 5 single-use code(s), 183 days\nFAKE-CODE\n" +
        "# alpha-staging-shared: 1 code, 50 redemptions, 183 days\nFAKE-CODE\n",
    );
  });

  test("mints a Grace pilot campaign: months, paid-plan refusal and expiry", () => {
    const campaign = {
      family: "grace_pilot",
      duration_months: "6",
      requires_no_paid_plan: "true",
      expires_at: "2099-12-31",
      single_use_count: "20",
      single_use_label: "grace-pilot-wave-1",
      shared_max_redemptions: "0",
    };
    expect(admit(campaign).ok).toBe(true);
    const { options, envelope } = mint(campaign);
    expect(options).toEqual([
      {
        count: 20,
        maxRedemptions: 1,
        durationDays: null,
        durationMonths: 6,
        requiresNoPaidPlan: true,
        planKey: "plus_monthly",
        family: "grace_pilot",
        expiresAt: new Date("2099-12-31T00:00:00Z"),
        label: "grace-pilot-wave-1",
      },
    ]);
    expect(envelope).toBe(
      "# grace-pilot-wave-1: 20 single-use code(s), 6 calendar months\nFAKE-CODE\n",
    );
  });

  test("passes a timestamp expiry and the pro plan through unchanged", () => {
    const run = {
      plan: "pro_monthly",
      duration_days: "30",
      expires_at: "2099-01-02T03:04:05Z",
    };
    expect(admit(run).ok).toBe(true);
    const [first] = mint(run).options;
    expect(first).toMatchObject({
      planKey: "pro_monthly",
      durationDays: 30,
      expiresAt: new Date("2099-01-02T03:04:05Z"),
    });
  });

  test.skipIf(process.platform === "darwin" && !gnuDate)(
    "admission refuses malformed, ambiguous and hostile inputs",
    () => {
      const refused: Array<[Record<string, string>, RegExp]> = [
        [{ family: "production_qa" }, /family must be/],
        [{ family: "alpha_phone; touch pwned" }, /family must be/],
        [{ plan: "enterprise" }, /plan must be/],
        [{ duration_days: "30", duration_months: "6" }, /mutually exclusive/],
        [{ duration_days: "0" }, /1 to 731/],
        [{ duration_days: "732" }, /1 to 731/],
        [{ duration_days: "$(id)" }, /1 to 731/],
        [{ duration_months: "25" }, /1 to 24/],
        [{ duration_months: "6x" }, /1 to 24/],
        [{ requires_no_paid_plan: "yes" }, /true or false/],
        [{ expires_at: "2099-12-31T00:00:00+02:00" }, /YYYY-MM-DD/],
        [{ expires_at: "2099-12-31 $(id)" }, /YYYY-MM-DD/],
        [{ expires_at: "2099-02-30" }, /real UTC time/],
        [{ expires_at: "2001-01-01" }, /in the future/],
        [{ single_use_count: "101" }, /capped/],
      ];
      for (const [overrides, message] of refused) {
        const result = admit(overrides);
        expect({ overrides, ok: result.ok }).toEqual({ overrides, ok: false });
        expect(result.output).toMatch(message);
      }
    },
  );

  test("inputs reach run scripts only through env", () => {
    for (const script of [admission, mintAndSeal]) {
      expect(script).not.toContain("${{");
    }
    expect(inputs.family).toMatchObject({
      options: ["alpha_phone", "grace_pilot"],
    });
  });
});
