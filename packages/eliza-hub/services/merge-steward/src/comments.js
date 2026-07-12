import { QUEUE_STATES } from "./policy.js";

export function renderQueueComment({ decision, item, integrationBranch } = {}) {
  const state = decision?.state ?? item?.queueState ?? QUEUE_STATES.OBSERVED;
  const title =
    state === QUEUE_STATES.READY || state === QUEUE_STATES.QUEUED
      ? "queued"
      : "blocked";
  const lines = [`Eliza Merge Steward: ${title}`, "", `State: ${state}`];

  if (decision?.risk) {
    lines.push(`Risk: ${decision.risk.level} (${decision.risk.score})`);
  }

  if (decision?.conflict) {
    lines.push(
      `Conflict: ${decision.conflict.level} (${decision.conflict.score})`,
    );
  }

  if (integrationBranch) {
    lines.push(`Integration branch: ${integrationBranch}`);
  }

  if (decision?.blockers?.length) {
    lines.push(`Reason: ${decision.blockers.join(", ")}`);
  }

  if (decision?.requiredActions?.length) {
    lines.push(`Required: ${decision.requiredActions.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}
