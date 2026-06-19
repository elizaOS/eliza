import { validateGithubLiveArtifacts } from "./validate-capability-router-github-live-artifacts.ts";

const observedGreenRun = {
  databaseId: 202,
  event: "workflow_dispatch",
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

const calls: Array<{ command: string; args: string[] }> = [];
validateGithubLiveArtifacts(
  {
    keepArtifacts: true,
    maxAgeMinutes: 120,
    outputDir: "/tmp/capability-router-live-artifacts",
    runId: "202",
  },
  (command, args) => {
    calls.push({ command, args });
    if (command === "gh" && args.includes("view")) {
      return JSON.stringify(observedGreenRun);
    }
    return "";
  },
);

assertCommand("downloads both named artifacts", "gh", [
  "run",
  "download",
  "202",
  "--dir",
  "/tmp/capability-router-live-artifacts",
  "--name",
  "remote-capability-cloud-live-report",
  "--name",
  "remote-capability-provider-live-report",
]);
assertCommandIncludes("validates cloud report artifact", "bun", [
  "test:remote-capabilities:validate-live-reports",
  "--kind",
  "cloud",
  "--expect-count",
  "1",
  "/tmp/capability-router-live-artifacts/remote-capability-cloud-live-report",
]);
assertCommandIncludes("validates provider report artifact", "bun", [
  "test:remote-capabilities:validate-live-reports",
  "--kind",
  "provider",
  "--expect-count",
  "3..4",
  "--allowed-providers",
  "e2b,home-machine,mobile-companion,desktop-companion",
  "--require-providers",
  "e2b,home-machine,mobile-companion",
  "/tmp/capability-router-live-artifacts/remote-capability-provider-live-report",
]);

assertFailsBeforeDownload(
  "push run is rejected before artifact download",
  { ...observedGreenRun, event: "push" },
  "run event must be workflow_dispatch or schedule",
);

console.log("Capability-router GitHub live artifact self-test passed.");

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
  };
}

function assertCommand(name: string, command: string, args: string[]): void {
  if (
    !calls.some(
      (call) =>
        call.command === command &&
        JSON.stringify(call.args) === JSON.stringify(args),
    )
  ) {
    throw new Error(`${name}: command was not observed.`);
  }
}

function assertCommandIncludes(
  name: string,
  command: string,
  expectedArgs: string[],
): void {
  if (
    !calls.some(
      (call) =>
        call.command === command &&
        expectedArgs.every((arg) => call.args.includes(arg)),
    )
  ) {
    throw new Error(`${name}: command args were not observed.`);
  }
}

function assertFailsBeforeDownload(
  name: string,
  run: typeof observedGreenRun,
  expectedMessage: string,
): void {
  const observedCalls: Array<{ command: string; args: string[] }> = [];
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    validateGithubLiveArtifacts(
      {
        keepArtifacts: true,
        maxAgeMinutes: 90,
        outputDir: "/tmp/capability-router-live-artifacts-rejected",
        runId: "203",
      },
      (command, args) => {
        observedCalls.push({ command, args });
        if (command === "gh" && args.includes("view")) {
          return JSON.stringify(run);
        }
        return "";
      },
    );
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode ?? 0;
  }
  if (!errors.some((error) => error.includes(expectedMessage))) {
    throw new Error(`${name}: failed for wrong reason: ${errors.join(", ")}`);
  }
  if (
    observedCalls.some(
      (call) => call.command === "gh" && call.args.includes("download"),
    )
  ) {
    throw new Error(`${name}: downloaded artifacts after rejected run metadata.`);
  }
}
