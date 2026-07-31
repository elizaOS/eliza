/**
 * Selects the newly created successful Cloudflare Pages production deployment
 * whose clean commit metadata exactly matches the verified workflow revision.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function asObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

export function selectSuccessfulProductionDeployment(
  apiResponse,
  { commitHash, notBefore },
) {
  const response = asObject(apiResponse, "Cloudflare deployment response");
  if (response.success !== true || !Array.isArray(response.result)) {
    throw new TypeError(
      "Cloudflare deployment response must be a successful result array",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(commitHash)) {
    throw new TypeError("expected deployment commit must be a full SHA");
  }
  if (!Number.isFinite(notBefore)) {
    throw new TypeError("deployment boundary must be an epoch timestamp");
  }

  const matches = response.result.flatMap((candidate) => {
    const deployment = asObject(candidate, "Cloudflare deployment");
    const trigger =
      deployment.deployment_trigger &&
      typeof deployment.deployment_trigger === "object"
        ? deployment.deployment_trigger
        : {};
    const metadata =
      trigger.metadata && typeof trigger.metadata === "object"
        ? trigger.metadata
        : {};
    const latestStage =
      deployment.latest_stage && typeof deployment.latest_stage === "object"
        ? deployment.latest_stage
        : {};
    const createdOn = Date.parse(deployment.created_on);
    if (
      deployment.environment !== "production" ||
      deployment.project_name !== "eliza-computer" ||
      deployment.is_skipped !== false ||
      latestStage.name !== "deploy" ||
      latestStage.status !== "success" ||
      metadata.branch !== "develop" ||
      metadata.commit_dirty !== false ||
      metadata.commit_hash !== commitHash ||
      !Number.isFinite(createdOn) ||
      createdOn < notBefore
    ) {
      return [];
    }
    if (
      typeof deployment.id !== "string" ||
      !/^[0-9a-f-]{20,}$/i.test(deployment.id) ||
      typeof deployment.url !== "string"
    ) {
      throw new TypeError(
        "matching Cloudflare deployment omitted a valid ID or URL",
      );
    }
    let deploymentUrl;
    try {
      deploymentUrl = new URL(deployment.url);
    } catch (error) {
      // error-policy:J2 retain the malformed matching deployment URL.
      throw new TypeError("matching Cloudflare deployment URL is invalid", {
        cause: error,
      });
    }
    if (deploymentUrl.protocol !== "https:") {
      throw new TypeError("matching Cloudflare deployment URL must use HTTPS");
    }
    return [
      {
        createdOn: deployment.created_on,
        createdOnEpoch: createdOn,
        id: deployment.id,
        url: deploymentUrl.href,
      },
    ];
  });

  return matches.sort(
    (left, right) => right.createdOnEpoch - left.createdOnEpoch,
  )[0];
}

function runCli() {
  if (process.argv.length !== 5) {
    throw new TypeError(
      "usage: select-pages-deployment.mjs <response.json> <commit-sha> <not-before-epoch-ms>",
    );
  }
  const response = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const deployment = selectSuccessfulProductionDeployment(response, {
    commitHash: process.argv[3],
    notBefore: Number(process.argv[4]),
  });
  if (!deployment) {
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    `${deployment.id}\t${deployment.url}\t${deployment.createdOn}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
