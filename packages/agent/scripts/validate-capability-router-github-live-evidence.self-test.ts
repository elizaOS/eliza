// Exercises validate capability router github live evidence.self test automation behavior with deterministic script fixtures.
import { validateGithubLiveEvidence } from "./validate-capability-router-github-live-evidence.ts";

const observedGreenRun = {
  databaseId: 101,
  event: "schedule",
  status: "completed",
  conclusion: "success",
  jobs: [
    liveJob("Cloud Live E2E (Eliza Cloud)", [
      "Remote capability cloud sandbox live smoke",
      "Validate remote capability cloud live report",
      "Upload remote capability cloud live report",
    ]),
    liveJob("Remote Capability Provider Live E2E", [
      "Remote capability URL-backed provider live smoke",
      "Validate remote capability provider live reports",
      "Upload remote capability provider live report",
    ]),
  ],
};

assertPasses("observed green run", observedGreenRun);

assertFails(
  "push run is not live evidence",
  {
    ...observedGreenRun,
    event: "push",
  },
  "run event must be workflow_dispatch or schedule",
);

assertPasses(
  "push run can be explicitly allowed as unobserved",
  {
    ...observedGreenRun,
    event: "push",
  },
  { allowUnobserved: true },
);

assertFails(
  "missing upload step",
  {
    ...observedGreenRun,
    jobs: [
      observedGreenRun.jobs[0],
      liveJob("Remote Capability Provider Live E2E", [
        "Remote capability URL-backed provider live smoke",
        "Validate remote capability provider live reports",
      ]),
    ],
  },
  "required live evidence step is missing",
);

assertFails(
  "skipped provider smoke",
  {
    ...observedGreenRun,
    jobs: [
      observedGreenRun.jobs[0],
      liveJob("Remote Capability Provider Live E2E", [
        "Remote capability URL-backed provider live smoke",
        "Validate remote capability provider live reports",
        "Upload remote capability provider live report",
      ]).withStep("Remote capability URL-backed provider live smoke", {
        conclusion: "skipped",
      }),
    ],
  },
  'must be "success"',
);

console.log("Capability-router GitHub live evidence self-test passed.");

function liveJob(name: string, steps: string[]) {
  return {
    name,
    status: "completed",
    conclusion: "success",
    steps: steps.map((step) => ({
      name: step,
      status: "completed",
      conclusion: "success",
    })),
    withStep(
      stepName: string,
      patch: Partial<{ conclusion: string; status: string }>,
    ) {
      return {
        ...this,
        steps: this.steps.map((step) =>
          step.name === stepName ? { ...step, ...patch } : step,
        ),
      };
    },
  };
}

function assertPasses(
  name: string,
  run: Parameters<typeof validateGithubLiveEvidence>[0],
  options?: Parameters<typeof validateGithubLiveEvidence>[1],
): void {
  const failures = validateGithubLiveEvidence(run, options);
  if (failures.length > 0) {
    throw new Error(
      `${name} unexpectedly failed: ${failures
        .map((failure) => failure.message)
        .join(", ")}`,
    );
  }
}

function assertFails(
  name: string,
  run: Parameters<typeof validateGithubLiveEvidence>[0],
  expectedMessage: string,
): void {
  const failures = validateGithubLiveEvidence(run);
  if (!failures.some((failure) => failure.message.includes(expectedMessage))) {
    throw new Error(
      `${name} failed for wrong reason: ${failures
        .map((failure) => failure.message)
        .join(", ")}`,
    );
  }
}
