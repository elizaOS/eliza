const ACTION_HANDLERS = Object.freeze({
  ensure_integration_branch: "ensureIntegrationBranch",
  merge_pr_head_into_integration: "mergePullRequestHeadIntoIntegration",
  wait_for_checks: "waitForIntegrationChecks",
  merge_original_pull_request: "mergeOriginalPullRequest",
});

export async function executeIntegrationPlan({
  plan,
  client,
  config = {},
  confirmed = false,
  beforeAction,
  onActionStart,
  onActionComplete,
} = {}) {
  if (!config.enabled) {
    return {
      enabled: false,
      dryRun: config.dryRun !== false,
      skipped: true,
      reason: "integration_disabled",
      executions: [],
    };
  }

  const plans = plan?.plans ?? [];
  if (plans.length === 0) {
    return {
      enabled: true,
      dryRun: config.dryRun !== false,
      skipped: true,
      reason: plan?.reason ?? "no_ready_items",
      executions: [],
    };
  }

  if (config.dryRun !== false) {
    return {
      enabled: true,
      dryRun: true,
      skipped: false,
      executions: plans.map((itemPlan) => dryRunExecution(itemPlan)),
    };
  }

  if (!confirmed) {
    return {
      enabled: true,
      dryRun: false,
      skipped: true,
      reason: "integration_execution_not_confirmed",
      executions: plans.map((itemPlan) =>
        blockedExecution(itemPlan, "integration_execution_not_confirmed"),
      ),
    };
  }

  const unsafePlan = plans.find(
    (itemPlan) =>
      !config.allowEmptyRequiredChecks &&
      (itemPlan.requiredChecks ?? []).length === 0,
  );
  if (unsafePlan) {
    return {
      enabled: true,
      dryRun: false,
      skipped: true,
      reason: "required_checks_missing",
      executions: plans.map((itemPlan) =>
        blockedExecution(
          itemPlan,
          itemPlan === unsafePlan
            ? "required_checks_missing"
            : "integration_execution_blocked",
        ),
      ),
    };
  }

  if (!client) {
    return {
      enabled: true,
      dryRun: false,
      skipped: true,
      reason: "integration_executor_unconfigured",
      executions: plans.map((itemPlan) =>
        blockedExecution(itemPlan, "integration_executor_unconfigured"),
      ),
    };
  }

  const executions = [];
  let trainBlocked = false;
  for (const itemPlan of plans) {
    if (trainBlocked) {
      executions.push(
        blockedExecution(itemPlan, "merge_train_predecessor_failed"),
      );
      continue;
    }

    try {
      const execution = await executeItemPlan({
        itemPlan,
        client,
        beforeAction,
        onActionStart,
        onActionComplete,
      });
      executions.push(execution);
      if (plans.length > 1 && execution.status !== "executed") {
        trainBlocked = true;
      }
    } catch (error) {
      // error-policy:J1 per-item integration boundary: failure is recorded as a
      // structured failed execution and blocks the rest of the train
      executions.push({
        repo: itemPlan.repo,
        pullRequestId: itemPlan.pullRequestId,
        integrationBranch: itemPlan.integrationBranch,
        status: "failed",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message:
            error instanceof Error
              ? error.message
              : "Unknown integration executor error",
          status: error?.status ?? null,
        },
        actions: [],
      });
      if (plans.length > 1) {
        trainBlocked = true;
      }
    }
  }

  return {
    enabled: true,
    dryRun: false,
    skipped: false,
    strategy: plans.length > 1 ? "merge-train" : "single-pr",
    executions,
  };
}

export async function executeItemPlan({
  itemPlan,
  client,
  beforeAction,
  onActionStart,
  onActionComplete,
} = {}) {
  const actionResults = [];
  const repo = parseRepoFullName(itemPlan?.repo);

  for (const action of itemPlan?.actions ?? []) {
    const guard = await evaluateActionGuard({
      beforeAction,
      itemPlan,
      action,
      repo,
      previousActions: actionResults,
    });
    if (!guard.ok) {
      actionResults.push(guardedActionFailure(action, guard));
      break;
    }

    const started = await checkpointIntegrationAction({
      callback: onActionStart,
      itemPlan,
      action,
      repo,
      previousActions: actionResults,
      phase: "started",
    });
    if (!started.ok) {
      actionResults.push(checkpointActionFailure(action, started));
      break;
    }

    const result = await executeAction({ itemPlan, action, client, repo });
    const completed = await checkpointIntegrationAction({
      callback: onActionComplete,
      itemPlan,
      action,
      repo,
      result,
      previousActions: actionResults,
      phase: "finished",
    });
    if (!completed.ok) {
      actionResults.push(checkpointActionFailure(action, completed));
      break;
    }

    actionResults.push(result);
    if (result.status === "failed" || result.status === "unsupported") {
      break;
    }
  }

  return {
    repo: itemPlan?.repo,
    pullRequestId: itemPlan?.pullRequestId,
    integrationBranch: itemPlan?.integrationBranch,
    status: executionStatus(actionResults),
    actions: actionResults,
  };
}

export async function executeAction({ itemPlan, action, client, repo } = {}) {
  const handlerName = ACTION_HANDLERS[action?.type];
  if (!handlerName || typeof client?.[handlerName] !== "function") {
    return {
      ...action,
      status: "unsupported",
      reason: "missing_integration_action_handler",
      handlerName: handlerName ?? null,
    };
  }

  try {
    if (action.type === "merge_original_pull_request") {
      const guard = await verifyCurrentPullRequestHead({
        client,
        repo,
        itemPlan,
        action,
      });
      if (!guard.ok) {
        return {
          ...action,
          status: "failed",
          reason: guard.reason,
          current: guard.current ?? null,
        };
      }
    }

    const output = await client[handlerName]({
      plan: itemPlan,
      action,
      repo,
    });
    return {
      ...action,
      status: "executed",
      output: output ?? null,
    };
  } catch (error) {
    // error-policy:J1 per-action boundary: failure becomes a structured failed
    // action result the run records
    return {
      ...action,
      status: "failed",
      error: {
        name: error instanceof Error ? error.name : "Error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown integration executor error",
        status: error?.status ?? null,
      },
    };
  }
}

function dryRunExecution(itemPlan) {
  return {
    repo: itemPlan.repo,
    pullRequestId: itemPlan.pullRequestId,
    integrationBranch: itemPlan.integrationBranch,
    status: "planned",
    actions: itemPlan.actions.map((action) => ({
      ...action,
      status: "planned",
    })),
  };
}

function blockedExecution(itemPlan, reason) {
  return {
    repo: itemPlan.repo,
    pullRequestId: itemPlan.pullRequestId,
    integrationBranch: itemPlan.integrationBranch,
    status: "blocked",
    reason,
    actions: itemPlan.actions.map((action) => ({
      ...action,
      status: "blocked",
      reason,
    })),
  };
}

async function verifyCurrentPullRequestHead({
  client,
  repo,
  itemPlan,
  action,
}) {
  if (typeof client.getPullRequest !== "function") {
    return { ok: true };
  }

  const current = await client.getPullRequest(repo, itemPlan.pullRequestId);
  const currentHeadSha = current?.head?.sha ?? current?.head_sha ?? null;
  const currentBaseBranch = current?.base?.ref ?? current?.base?.branch ?? null;
  const expectedHeadSha = action.expectedHeadSha ?? itemPlan.headSha ?? null;

  if (current?.merged === true) {
    return {
      ok: false,
      reason: "pull_request_already_merged",
      current: summarizePullRequest(current),
    };
  }
  if (current?.state && current.state !== "open") {
    return {
      ok: false,
      reason: "pull_request_not_open",
      current: summarizePullRequest(current),
    };
  }
  if (
    itemPlan.targetBranch &&
    currentBaseBranch &&
    currentBaseBranch !== itemPlan.targetBranch
  ) {
    return {
      ok: false,
      reason: "target_branch_changed",
      current: summarizePullRequest(current),
    };
  }
  if (expectedHeadSha && currentHeadSha !== expectedHeadSha) {
    return {
      ok: false,
      reason: "head_sha_changed",
      current: summarizePullRequest(current),
    };
  }

  return { ok: true, current: summarizePullRequest(current) };
}

function summarizePullRequest(pullRequest) {
  return {
    number: pullRequest?.number ?? pullRequest?.index ?? null,
    state: pullRequest?.state ?? null,
    merged: pullRequest?.merged ?? null,
    headSha: pullRequest?.head?.sha ?? pullRequest?.head_sha ?? null,
    baseBranch: pullRequest?.base?.ref ?? pullRequest?.base?.branch ?? null,
  };
}

function parseRepoFullName(fullName) {
  const [owner, repo, ...rest] = String(fullName ?? "").split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new TypeError(
      "Integration executor requires repo in owner/name form",
    );
  }
  return { owner, repo };
}

async function evaluateActionGuard({
  beforeAction,
  itemPlan,
  action,
  repo,
  previousActions,
} = {}) {
  if (typeof beforeAction !== "function") {
    return { ok: true };
  }

  try {
    const result = await beforeAction({
      itemPlan,
      action,
      repo,
      previousActions,
    });
    if (result === false) {
      return { ok: false, reason: "integration_action_guard_blocked" };
    }
    if (result && typeof result === "object" && result.ok === false) {
      return {
        ok: false,
        reason: result.reason ?? "integration_action_guard_blocked",
        details: result,
      };
    }
    return { ok: true, details: result ?? null };
  } catch (error) {
    // error-policy:J1 guard evaluation failure blocks the action with a
    // structured reason
    return {
      ok: false,
      reason: "integration_action_guard_failed",
      error: serializeError(error),
    };
  }
}

function guardedActionFailure(action, guard) {
  const result = {
    ...action,
    status: "failed",
    reason: guard.reason ?? "integration_action_guard_blocked",
  };
  if (guard.details) result.guard = guard.details;
  if (guard.error) result.error = guard.error;
  return result;
}

async function checkpointIntegrationAction({
  callback,
  itemPlan,
  action,
  repo,
  result,
  previousActions,
  phase,
} = {}) {
  if (typeof callback !== "function") {
    return { ok: true };
  }

  try {
    const checkpoint = await callback({
      itemPlan,
      action,
      repo,
      result,
      previousActions,
      phase,
    });
    if (checkpoint === false) {
      return {
        ok: false,
        reason: "integration_action_checkpoint_failed",
        phase,
      };
    }
    if (
      checkpoint &&
      typeof checkpoint === "object" &&
      checkpoint.ok === false
    ) {
      return {
        ok: false,
        reason: checkpoint.reason ?? "integration_action_checkpoint_failed",
        details: checkpoint,
        phase,
        result,
      };
    }
    return { ok: true };
  } catch (error) {
    // error-policy:J1 checkpoint failure blocks the action with a structured
    // reason
    return {
      ok: false,
      reason: "integration_action_checkpoint_failed",
      phase,
      result,
      error: serializeError(error),
    };
  }
}

function checkpointActionFailure(action, checkpoint) {
  const result = {
    ...action,
    status: "failed",
    reason: checkpoint.reason ?? "integration_action_checkpoint_failed",
    checkpoint: {
      phase: checkpoint.phase ?? null,
      actionResult: checkpoint.result ?? null,
      details: checkpoint.details ?? null,
      error: checkpoint.error ?? null,
    },
  };
  return result;
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      status: error.status ?? null,
    };
  }
  return {
    name: "Error",
    message: String(error ?? "Unknown integration executor error"),
    status: null,
  };
}

function executionStatus(actionResults) {
  if (actionResults.some((result) => result.status === "failed"))
    return "failed";
  if (actionResults.some((result) => result.status === "unsupported"))
    return "blocked";
  if (actionResults.length === 0) return "skipped";
  return "executed";
}
