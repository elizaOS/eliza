/**
 * Executable contract for the credentials and non-secret variables the
 * canonical multi-store release legs consume from the protected
 * `production-release` GitHub Environment.
 *
 * The contract is authored here, per store lane, together with the human
 * ownership required by the provisioning policy (rotation cadence, recovery
 * path, revocation path). `auditWorkflowCoverage` re-derives the names the
 * shipped workflows actually reference and fails on drift in either direction,
 * so this file cannot silently disagree with `.github/workflows`.
 *
 * Only names are handled anywhere in this module. Credential values must never
 * be read, printed, or persisted by the preflight that consumes it.
 */

export const RELEASE_ENVIRONMENT = "production-release";

/**
 * Names referenced by the store workflows that are runner/fleet routing
 * controls rather than store credentials. They are repository-level and are
 * deliberately outside the environment credential contract.
 */
export const NON_CREDENTIAL_VARIABLES = Object.freeze([
  "HETZNER_FLEET_ONLINE",
  "RUNNER_WINDOWS",
]);

/**
 * Repo-owned policy contract for the protected environment itself, checked by
 * the live audit alongside the name inventory. Deployments to
 * `production-release` legitimately originate from exactly two refs:
 * `release.yaml` enforces that the canonical release transaction (and the
 * reusable store legs it calls) runs on `refs/heads/develop`, and
 * `release-electrobun.yml` runs on the pushed `v*` release tag. The
 * environment's deployment policy must therefore use custom branch policies
 * admitting exactly those two patterns — protected-branches-only, any-branch,
 * and any additional pattern all violate the contract.
 *
 * `authorizedReviewers` is the allowlist of GitHub principals (user logins or
 * `org/team` slugs) permitted to approve a production-release deployment. It
 * is deliberately empty until a repository owner verifies and commits the
 * list; while it is empty the live audit reports the resolved reviewer
 * principals as an owner-verification blocker instead of READY, so an
 * arbitrary reviewer can never satisfy the gate by existing.
 */
export const RELEASE_ENVIRONMENT_POLICY = Object.freeze({
  deploymentRefs: Object.freeze([
    Object.freeze({ type: "branch", name: "develop" }),
    Object.freeze({ type: "tag", name: "v*" }),
  ]),
  preventSelfReview: true,
  authorizedReviewers: Object.freeze([]),
});

/**
 * @typedef {object} StoreLane
 * @property {string} id Stable lane identifier used by the CLI and tests.
 * @property {string} provider Human name of the publisher portal.
 * @property {string} workflow Workflow file that consumes the lane.
 * @property {string[]} secrets Environment secret names, publish fails closed without them.
 * @property {string[]} variables Non-secret environment variable names.
 * @property {string} prerequisite Account/product state required before provisioning.
 * @property {string} owner Team accountable for the credential lifecycle.
 * @property {string} rotation Rotation cadence and mechanism.
 * @property {string} revocation How the credential is revoked at the provider.
 */

/** @type {readonly StoreLane[]} */
export const STORE_LANES = Object.freeze([
  Object.freeze({
    id: "snap",
    provider: "Snap Store",
    workflow: ".github/workflows/snap-publish.yml",
    secrets: Object.freeze(["SNAPCRAFT_STORE_CREDENTIALS"]),
    variables: Object.freeze([]),
    prerequisite:
      "Registered `eliza` snap name owned by the company Snapcraft account.",
    owner: "Release engineering",
    rotation:
      "Re-export every 90 days with `snapcraft export-login --snaps eliza --channels edge,beta,candidate,stable --acls package_access,package_push,package_release -`.",
    revocation:
      "Revoke the exported macaroon in the Snapcraft account authentication settings, then re-export.",
  }),
  Object.freeze({
    id: "google-play",
    provider: "Google Play Console",
    workflow: ".github/workflows/store-mobile-publish.yml",
    secrets: Object.freeze([
      "ANDROID_KEYSTORE_BASE64",
      "ANDROID_KEYSTORE_PASSWORD",
      "ANDROID_KEY_ALIAS",
      "ANDROID_KEY_PASSWORD",
      "PLAY_STORE_SERVICE_ACCOUNT_JSON",
    ]),
    variables: Object.freeze([]),
    prerequisite:
      "Google Play developer account plus an application record for the release package name.",
    owner: "Release engineering (upload key custody shared with security)",
    rotation:
      "Rotate the Play service-account key every 90 days in Google Cloud IAM; the upload keystore rotates only through a Play upload-key reset.",
    revocation:
      "Delete the service-account key in Google Cloud IAM and remove the account from the Play Console users list.",
  }),
  Object.freeze({
    id: "apple",
    provider: "Apple App Store Connect",
    workflow: ".github/workflows/store-mobile-publish.yml",
    secrets: Object.freeze([
      "APPLE_ID",
      "APPLE_TEAM_ID",
      "ITC_TEAM_ID",
      "APP_STORE_APP_ID",
      "MATCH_PASSWORD",
      "MATCH_GIT_URL",
      "MATCH_GIT_BASIC_AUTHORIZATION",
      "APP_STORE_API_KEY_ID",
      "APP_STORE_API_ISSUER_ID",
      "APP_STORE_API_KEY_P8",
    ]),
    variables: Object.freeze([]),
    prerequisite:
      "Apple Developer Program organization membership, an App Store Connect app record, and accepted agreements.",
    owner: "Release engineering (Account Holder actions with the org owner)",
    rotation:
      "Rotate the App Store Connect API key every 180 days; rotate the match repository token on the same cadence.",
    revocation:
      "Revoke the API key in App Store Connect > Users and Access > Integrations, and revoke the match repository token.",
  }),
  Object.freeze({
    id: "microsoft",
    provider: "Microsoft Partner Center",
    workflow: ".github/workflows/store-windows-publish.yml",
    secrets: Object.freeze([
      "MICROSOFT_STORE_TENANT_ID",
      "MICROSOFT_STORE_CLIENT_ID",
      "MICROSOFT_STORE_CLIENT_SECRET",
    ]),
    variables: Object.freeze([
      "MICROSOFT_STORE_IDENTITY_NAME",
      "MICROSOFT_STORE_PUBLISHER_ID",
      "MICROSOFT_STORE_PUBLISHER_DISPLAY_NAME",
      "MICROSOFT_STORE_APPLICATION_ID",
    ]),
    prerequisite:
      "Microsoft Partner Center account with a reserved app identity and a completed first manual submission.",
    owner:
      "Release engineering (Partner Center Manager role with the org owner)",
    rotation:
      "Rotate the Entra application client secret every 180 days and update the environment secret in the same change window.",
    revocation:
      "Delete the client secret on the Entra app registration and remove the Azure AD tenant association in Partner Center.",
  }),
]);

/** Every environment secret name the store lanes require. */
export function requiredSecretNames() {
  return [...new Set(STORE_LANES.flatMap((lane) => lane.secrets))].sort();
}

/** Every environment variable name the store lanes require. */
export function requiredVariableNames() {
  return [...new Set(STORE_LANES.flatMap((lane) => lane.variables))].sort();
}

/**
 * Extract `secrets.NAME` / `vars.NAME` references from raw workflow YAML.
 *
 * @param {string} source Raw workflow file contents.
 * @returns {{ secrets: string[], variables: string[] }}
 */
export function extractWorkflowReferences(source) {
  const secrets = new Set();
  const variables = new Set();
  for (const match of source.matchAll(/\b(secrets|vars)\.([A-Z0-9_]+)\b/g)) {
    const [, kind, name] = match;
    if (kind === "secrets") {
      if (name !== "GITHUB_TOKEN") secrets.add(name);
    } else {
      variables.add(name);
    }
  }
  return {
    secrets: [...secrets].sort(),
    variables: [...variables].sort(),
  };
}

/**
 * Compare the authored contract with what the workflows actually reference.
 *
 * @param {Record<string, string>} workflowSources Workflow path to raw contents.
 * @returns {{ ok: boolean, missingInWorkflows: string[], missingInContract: string[] }}
 */
export function auditWorkflowCoverage(workflowSources) {
  const referencedSecrets = new Set();
  const referencedVariables = new Set();
  const perWorkflow = new Map();

  for (const [path, source] of Object.entries(workflowSources)) {
    const refs = extractWorkflowReferences(source);
    perWorkflow.set(path, refs);
    for (const name of refs.secrets) referencedSecrets.add(name);
    for (const name of refs.variables) {
      if (!NON_CREDENTIAL_VARIABLES.includes(name))
        referencedVariables.add(name);
    }
  }

  const missingInWorkflows = [];
  for (const lane of STORE_LANES) {
    const refs = perWorkflow.get(lane.workflow);
    if (!refs) {
      missingInWorkflows.push(`${lane.workflow} (not supplied)`);
      continue;
    }
    for (const name of lane.secrets) {
      if (!refs.secrets.includes(name)) {
        missingInWorkflows.push(`secrets.${name} in ${lane.workflow}`);
      }
    }
    for (const name of lane.variables) {
      if (!refs.variables.includes(name)) {
        missingInWorkflows.push(`vars.${name} in ${lane.workflow}`);
      }
    }
  }

  const contractSecrets = new Set(requiredSecretNames());
  const contractVariables = new Set(requiredVariableNames());
  const missingInContract = [
    ...[...referencedSecrets]
      .filter((name) => !contractSecrets.has(name))
      .map((name) => `secrets.${name}`),
    ...[...referencedVariables]
      .filter((name) => !contractVariables.has(name))
      .map((name) => `vars.${name}`),
  ].sort();

  return {
    ok: missingInWorkflows.length === 0 && missingInContract.length === 0,
    missingInWorkflows: missingInWorkflows.sort(),
    missingInContract,
  };
}

/**
 * Evaluate the protection-rule and deployment-branch-policy details of the
 * live environment against {@link RELEASE_ENVIRONMENT_POLICY}. Every setting
 * the API could not prove (`null`) is a blocker, never a pass: the audit fails
 * closed on unreadable state.
 *
 * @param {object} live See {@link evaluateEnvironmentReadiness}.
 * @param {typeof RELEASE_ENVIRONMENT_POLICY} policy
 * @returns {string[]} Policy blockers, empty when the policy is proven.
 */
function evaluatePolicy(live, policy) {
  const blockers = [];

  if (live.reviewers === null || live.reviewers === undefined) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT}: required reviewers could not be read; owner verification required.`,
    );
  } else if (live.reviewers.length === 0) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT} has no required reviewers.`,
    );
  } else if (policy.authorizedReviewers.length === 0) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT}: reviewer allowlist is empty in the contract; an owner must verify [${live.reviewers
        .map((reviewer) => reviewer.login)
        .join(", ")}] and commit RELEASE_ENVIRONMENT_POLICY.authorizedReviewers.`,
    );
  } else {
    for (const reviewer of live.reviewers) {
      if (!policy.authorizedReviewers.includes(reviewer.login)) {
        blockers.push(
          `Environment ${RELEASE_ENVIRONMENT}: reviewer ${reviewer.login} is not in the authorized reviewer allowlist.`,
        );
      }
    }
  }

  if (live.preventSelfReview === null || live.preventSelfReview === undefined) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT}: prevent_self_review could not be read; owner verification required.`,
    );
  } else if (policy.preventSelfReview && live.preventSelfReview !== true) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT} does not prevent self-review of deployments.`,
    );
  }

  const branchPolicy = live.branchPolicy;
  if (branchPolicy === undefined) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT}: deployment branch policy could not be read; owner verification required.`,
    );
    return blockers;
  }
  if (branchPolicy === null) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT} admits deployments from any branch; restrict it to the canonical release ref.`,
    );
    return blockers;
  }
  if (branchPolicy.protectedBranches || !branchPolicy.customBranchPolicies) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT} uses a protected-branches-only deployment policy; the contract requires custom branch policies admitting only the canonical release ref.`,
    );
    return blockers;
  }

  const patterns = live.branchPolicyPatterns;
  if (patterns === null || patterns === undefined) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT}: custom deployment branch policies could not be read; owner verification required.`,
    );
    return blockers;
  }
  const admits = (ref) =>
    patterns.some(
      (pattern) => pattern.type === ref.type && pattern.name === ref.name,
    );
  for (const ref of policy.deploymentRefs) {
    if (!admits(ref)) {
      blockers.push(
        `Environment ${RELEASE_ENVIRONMENT}: deployment policy does not admit the canonical release ref ${ref.type} ${ref.name}.`,
      );
    }
  }
  const canonical = (pattern) =>
    policy.deploymentRefs.some(
      (ref) => ref.type === pattern.type && ref.name === pattern.name,
    );
  for (const pattern of patterns) {
    if (!canonical(pattern)) {
      blockers.push(
        `Environment ${RELEASE_ENVIRONMENT}: deployment policy admits noncanonical ${pattern.type} pattern ${pattern.name}.`,
      );
    }
  }
  return blockers;
}

/**
 * Reduce a live environment inspection to the per-lane provisioning state and
 * the policy blockers. Name presence proves provisioning only; it cannot prove
 * a credential value is nonempty, current, or bound to the right provider
 * identity — that proof comes from a real protected store publish, and the
 * returned `caveat` states so.
 *
 * @param {object} live
 * @param {boolean} live.environmentExists Whether `production-release` exists.
 * @param {string[]} live.secretNames Secret names present in the environment.
 * @param {string[]} live.variableNames Variable names present in the environment.
 * @param {{ login: string, type: string }[] | null} [live.reviewers] Resolved
 *   required-reviewer principals, or null when unreadable.
 * @param {boolean | null} [live.preventSelfReview] Whether self-review is
 *   prevented, or null when unreadable.
 * @param {{ protectedBranches: boolean, customBranchPolicies: boolean } | null} [live.branchPolicy]
 *   The deployment branch policy object, null when the environment admits any
 *   branch, undefined when unreadable.
 * @param {{ name: string, type: string }[] | null} [live.branchPolicyPatterns]
 *   Resolved custom branch/tag policy patterns, or null when unreadable.
 * @param {typeof RELEASE_ENVIRONMENT_POLICY} [policy]
 */
export function evaluateEnvironmentReadiness(
  live,
  policy = RELEASE_ENVIRONMENT_POLICY,
) {
  const secretNames = new Set(live.secretNames ?? []);
  const variableNames = new Set(live.variableNames ?? []);

  const lanes = STORE_LANES.map((lane) => {
    const missingSecrets = lane.secrets.filter(
      (name) => !secretNames.has(name),
    );
    const missingVariables = lane.variables.filter(
      (name) => !variableNames.has(name),
    );
    return {
      id: lane.id,
      provider: lane.provider,
      ready:
        live.environmentExists &&
        missingSecrets.length === 0 &&
        missingVariables.length === 0,
      missingSecrets,
      missingVariables,
    };
  });

  const blockers = [];
  if (!live.environmentExists) {
    blockers.push(
      `Environment ${RELEASE_ENVIRONMENT} does not exist; every store job would be blocked at deployment.`,
    );
  } else {
    blockers.push(...evaluatePolicy(live, policy));
  }
  for (const lane of lanes) {
    for (const name of lane.missingSecrets) {
      blockers.push(`${lane.provider}: missing secret ${name}`);
    }
    for (const name of lane.missingVariables) {
      blockers.push(`${lane.provider}: missing variable ${name}`);
    }
  }

  return {
    ready: blockers.length === 0,
    lanes,
    blockers,
    caveat:
      "Name and policy inventory only: credential validity is proven exclusively by a real protected store publish.",
  };
}
