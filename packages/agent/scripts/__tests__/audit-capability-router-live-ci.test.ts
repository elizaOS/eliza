/**
 * Regression coverage for manual remote-capability observation and cleanup
 * guards in the Tests workflow. The focused assertions complement the broader
 * mutation script with a conventional unit-test entrypoint for CI coverage.
 */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCapabilityRouterLiveCi } from "../audit-capability-router-live-ci";

const workflow = readFileSync(
  fileURLToPath(
    new URL("../../../../.github/workflows/test.yml", import.meta.url),
  ),
  "utf8",
);

const manualObservationChecks = [
  "manual remote capability live observation is explicit",
  "cloud capability live smoke is explicitly configured",
  "provider live smoke skips when manual observation was not requested",
];

const cleanupChecks = [
  "cloud live report prune only runs after checkout-backed live runs",
  "provider live report prune only runs after checkout-backed live runs",
];

test("manual dispatch requires explicit remote-capability observation", () => {
  expect(
    validateCapabilityRouterLiveCi(workflow, {
      onlyCheckNames: manualObservationChecks,
    }),
  ).toEqual([]);

  const withoutInput = workflow.replace(
    '      remote_capability_live:\n        description: "Run strict remote-capability Cloud and provider live smokes"\n        required: false\n        default: false\n        type: boolean\n',
    "",
  );
  expect(
    validateCapabilityRouterLiveCi(withoutInput, {
      onlyCheckNames: manualObservationChecks,
    }).map((failure) => failure.name),
  ).toContain("manual remote capability live observation is explicit");
});

test("live report cleanup requires a successful checkout", () => {
  expect(
    validateCapabilityRouterLiveCi(workflow, { onlyCheckNames: cleanupChecks }),
  ).toEqual([]);

  const withoutCheckoutGuard = workflow.replaceAll(
    "steps.checkout.outcome == 'success' && ",
    "",
  );
  expect(
    validateCapabilityRouterLiveCi(withoutCheckoutGuard, {
      onlyCheckNames: cleanupChecks,
    }).map((failure) => failure.name),
  ).toEqual(cleanupChecks);
});
