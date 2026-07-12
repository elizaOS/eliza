const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";

const CORE_ISOLATION_CHECKS = new Set([
  "runner_config_present",
  "host_docker_socket_absent",
  "host_labels_absent",
  "dind_isolated_network",
  "runner_uses_dind",
  "runner_capacity_limited",
  "workflow_containers_unprivileged",
]);

export function buildRunnerIsolationAudit(input = {}) {
  const composeConfig = asText(input.composeConfig);
  const runnerConfig = asText(input.runnerConfig);
  const combinedConfig = `${composeConfig}\n${runnerConfig}`;
  const registration = input.registration ?? {};
  const smoke = input.smoke ?? {};
  const reviews = input.reviews ?? {};
  const snapshots = buildSnapshots({
    composeConfig,
    runnerConfig,
    combinedConfig,
  });

  const checks = [
    checkRunnerConfigPresent({ composeConfig, runnerConfig }),
    checkHostDockerSocketAbsent(snapshots),
    checkHostLabelsAbsent(snapshots),
    checkDindIsolatedNetwork({ composeConfig, snapshots }),
    checkRunnerUsesDind(snapshots),
    checkRunnerCapacityLimited(snapshots),
    checkWorkflowContainersUnprivileged({ runnerConfig, snapshots }),
    checkAttestation({
      name: "runner_registration_tested",
      passed:
        truthy(registration.tested) ||
        truthy(registration.registered) ||
        truthy(registration.ok),
      failReason:
        "Runner registration has not been proven on the target Forgejo instance.",
      action:
        "Register the isolated runner against the target Forgejo instance and record the successful check.",
    }),
    checkAttestation({
      name: "trusted_smoke_workflow_passed",
      passed:
        truthy(smoke.trustedWorkflowPassed) ||
        truthy(smoke.passed) ||
        truthy(smoke.ok) ||
        truthy(smoke.workflowRun?.passed),
      failReason:
        "A trusted runs-on: docker smoke workflow has not been observed passing.",
      action:
        "Run a trusted smoke workflow that exercises checkout and Docker execution, then record the passing run.",
    }),
    checkAttestation({
      name: "runner_egress_reviewed",
      passed: truthy(reviews.egressReviewed),
      failReason:
        "Runner outbound network access has not been reviewed for the release.",
      action:
        "Review runner egress policy for the release and record the approval.",
    }),
    checkAttestation({
      name: "runner_secret_exposure_reviewed",
      passed: truthy(reviews.secretExposureReviewed),
      failReason:
        "Runner secret exposure has not been reviewed for the release.",
      action:
        "Review workflow secrets and token exposure for the runner, then record the approval.",
    }),
  ];

  const status = deriveStatus(checks);
  const evidence = {
    runner: {
      isolated: [...CORE_ISOLATION_CHECKS].every((name) =>
        checkPassed(checks, name),
      ),
      noHostDockerSocket: checkPassed(checks, "host_docker_socket_absent"),
      noHostLabels: checkPassed(checks, "host_labels_absent"),
      registrationTested: checkPassed(checks, "runner_registration_tested"),
      trustedSmokeWorkflowPassed: checkPassed(
        checks,
        "trusted_smoke_workflow_passed",
      ),
      egressReviewed: checkPassed(checks, "runner_egress_reviewed"),
      secretExposureReviewed: checkPassed(
        checks,
        "runner_secret_exposure_reviewed",
      ),
    },
  };

  return {
    computedAt: input.now ?? new Date().toISOString(),
    status,
    productionReady: status === "isolated",
    summary: summarize(status, checks),
    checks,
    labels: buildLabels({ status, evidence }),
    requiredActions: requiredActions(checks),
    evidence,
    snapshots,
  };
}

function checkRunnerConfigPresent({ composeConfig, runnerConfig }) {
  if (composeConfig.trim() !== "" && runnerConfig.trim() !== "") {
    return pass(
      "runner_config_present",
      "Runner compose and runner config were provided.",
    );
  }

  return fail(
    "runner_config_present",
    "Runner compose config and runner config must both be supplied.",
    [
      "Render compose.actions-runner.yml and include the runner config before generating production evidence.",
    ],
  );
}

function checkHostDockerSocketAbsent(snapshots) {
  if (!snapshots.referencesHostSocket) {
    return pass(
      "host_docker_socket_absent",
      "Runner config does not mount or reference the host Docker socket.",
    );
  }

  return fail(
    "host_docker_socket_absent",
    "Runner config references /var/run/docker.sock.",
    [
      "Remove host Docker socket mounts and route runner jobs through the isolated DIND service.",
    ],
    { dockerHosts: snapshots.dockerHosts },
  );
}

function checkHostLabelsAbsent(snapshots) {
  if (snapshots.hostLabels.length === 0) {
    return pass(
      "host_labels_absent",
      "Runner labels do not expose the host executor.",
    );
  }

  return fail(
    "host_labels_absent",
    "Runner labels include host executor labels.",
    [
      "Replace :host labels with docker executor labels before enabling the runner.",
    ],
    { hostLabels: snapshots.hostLabels },
  );
}

function checkDindIsolatedNetwork({ composeConfig, snapshots }) {
  if (composeConfig.trim() === "") {
    return fail(
      "dind_isolated_network",
      "Runner compose config was not provided.",
      [
        "Render the runner compose config before checking DIND network isolation.",
      ],
    );
  }

  if (!/\bactions-dind\b/.test(composeConfig)) {
    return fail(
      "dind_isolated_network",
      "Runner compose config does not declare an actions-dind service.",
      [
        "Use an isolated Docker-in-Docker service instead of host Docker for Actions jobs.",
      ],
    );
  }

  if (snapshots.hasPublishedPorts) {
    return fail(
      "dind_isolated_network",
      "Runner compose config publishes ports from the runner stack.",
      [
        "Keep the DIND runner network internal and remove public port publishing from the runner compose file.",
      ],
    );
  }

  if (!snapshots.hasInternalNetwork) {
    return fail(
      "dind_isolated_network",
      "Runner compose config does not mark the runner network as internal.",
      [
        "Set the runner network to internal: true so DIND is not reachable from outside the compose network.",
      ],
    );
  }

  return pass(
    "dind_isolated_network",
    "DIND is declared on an internal network with no published ports.",
  );
}

function checkRunnerUsesDind(snapshots) {
  if (
    snapshots.dockerHosts.some((host) => host.startsWith("tcp://actions-dind"))
  ) {
    return pass(
      "runner_uses_dind",
      "Runner jobs are configured to use the actions-dind Docker host.",
    );
  }

  return fail(
    "runner_uses_dind",
    "Runner jobs are not configured to use tcp://actions-dind.",
    [
      "Set DOCKER_HOST and runner container docker_host to tcp://actions-dind:2375.",
    ],
    { dockerHosts: snapshots.dockerHosts },
  );
}

function checkRunnerCapacityLimited(snapshots) {
  if (snapshots.capacity == null) {
    return warn("runner_capacity_limited", "Runner capacity is not declared.", [
      "Set runner capacity to 1 for the first production launch, or record an explicit scaling review.",
    ]);
  }

  if (snapshots.capacity <= 1) {
    return pass(
      "runner_capacity_limited",
      "Runner capacity is limited to one concurrent job.",
    );
  }

  return warn(
    "runner_capacity_limited",
    `Runner capacity is ${snapshots.capacity}, which needs an explicit scaling review.`,
    [
      "Lower runner capacity to 1 for launch or attach an approved scaling and isolation review.",
    ],
    { capacity: snapshots.capacity },
  );
}

function checkWorkflowContainersUnprivileged({ runnerConfig, snapshots }) {
  if (/^\s*privileged:\s*true\s*$/m.test(runnerConfig)) {
    return fail(
      "workflow_containers_unprivileged",
      "Workflow containers are configured as privileged.",
      ["Set runner container privileged: false for workflow job containers."],
    );
  }

  if (snapshots.workflowContainersPrivileged === false) {
    return pass(
      "workflow_containers_unprivileged",
      "Workflow containers are explicitly unprivileged.",
    );
  }

  return warn(
    "workflow_containers_unprivileged",
    "Workflow container privileged mode is not declared.",
    [
      "Set runner container privileged: false and regenerate runner isolation evidence.",
    ],
  );
}

function checkAttestation({ name, passed, failReason, action }) {
  if (passed) return pass(name, "Launch attestation was recorded.");
  return fail(name, failReason, [action]);
}

function buildSnapshots({ composeConfig, runnerConfig, combinedConfig }) {
  const labels = extractRunnerLabels(runnerConfig);

  return {
    dockerHosts: extractDockerHosts(combinedConfig),
    labels,
    capacity: extractCapacity(runnerConfig),
    hasInternalNetwork: /^\s*internal:\s*true\s*$/m.test(composeConfig),
    hasPublishedPorts: /^\s*ports:\s*$/m.test(composeConfig),
    referencesHostSocket: /\/var\/run\/docker\.sock/.test(combinedConfig),
    hostLabels: labels.filter((label) => /:host\b/.test(label)),
    workflowContainersPrivileged: extractWorkflowPrivileged(runnerConfig),
  };
}

function extractDockerHosts(value) {
  return unique(
    [
      ...value.matchAll(
        /(?:tcp:\/\/[A-Za-z0-9_.-]+(?::\d+)?|unix:\/\/\/[^\s"']+|\/var\/run\/docker\.sock)/g,
      ),
    ].map((match) => match[0]),
  );
}

function extractRunnerLabels(value) {
  return unique(
    [...value.matchAll(/^\s*-\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/gm)]
      .map((match) => match[1].trim())
      .filter((label) => label.includes(":")),
  );
}

function extractCapacity(value) {
  const match = value.match(/^\s*capacity:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function extractWorkflowPrivileged(value) {
  if (/^\s*privileged:\s*true\s*$/m.test(value)) return true;
  if (/^\s*privileged:\s*false\s*$/m.test(value)) return false;
  return null;
}

function buildLabels({ status, evidence }) {
  const labels = [`runner-isolation:${status}`];
  labels.push(
    evidence.runner.registrationTested
      ? "runner-registration:verified"
      : "runner-registration:missing",
  );
  labels.push(
    evidence.runner.trustedSmokeWorkflowPassed
      ? "runner-smoke:passed"
      : "runner-smoke:missing",
  );
  return labels;
}

function deriveStatus(checks) {
  if (checks.some((check) => check.status === FAIL)) return "blocked";
  if (checks.some((check) => check.status === WARN)) return "watch";
  return "isolated";
}

function summarize(status, checks) {
  if (status === "isolated")
    return "Runner isolation evidence is complete and production-ready.";
  const failures = checks.filter((check) => check.status === FAIL).length;
  const warnings = checks.filter((check) => check.status === WARN).length;
  if (failures > 0)
    return `Runner isolation is blocked by ${failures} failed check${failures === 1 ? "" : "s"}.`;
  return `Runner isolation needs review for ${warnings} warning${warnings === 1 ? "" : "s"}.`;
}

function requiredActions(checks) {
  return unique(
    checks.flatMap((check) =>
      check.status === PASS ? [] : check.requiredActions,
    ),
  );
}

function checkPassed(checks, name) {
  return checks.some((check) => check.name === name && check.status === PASS);
}

function pass(name, reason, details = {}) {
  return {
    name,
    status: PASS,
    severity: "info",
    reason,
    requiredActions: [],
    details,
  };
}

function warn(name, reason, requiredActions, details = {}) {
  return {
    name,
    status: WARN,
    severity: "medium",
    reason,
    requiredActions,
    details,
  };
}

function fail(name, reason, requiredActions, details = {}) {
  return {
    name,
    status: FAIL,
    severity: "high",
    reason,
    requiredActions,
    details,
  };
}

function truthy(value) {
  return value === true;
}

function asText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function unique(values) {
  return [...new Set(values.filter((value) => value != null && value !== ""))];
}
