/**
 * Resolves fork workflows that GitHub has held for maintainer approval. Both
 * base-trusted aggregate gates consume this exact-head view before deciding
 * whether absent check runs are genuinely pending. Malformed API pages fail
 * before an adapter error can be mistaken for an empty workflow inventory.
 */

const ACTION_REQUIRED = "action_required";
const PAGE_SIZE = 100;

function workflowRunsFromPage(payload, page, url) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !Array.isArray(payload.workflow_runs)
  ) {
    throw new Error(
      `invalid GitHub Actions workflow-runs response at page ${page} (${url}): expected an object with a workflow_runs array`,
    );
  }
  return payload.workflow_runs;
}

export function actionRequiredWorkflowPaths(workflowRuns, headSha) {
  const newestByPath = new Map();

  for (const run of workflowRuns) {
    if (
      run.head_sha !== headSha ||
      run.event !== "pull_request" ||
      typeof run.path !== "string" ||
      run.path.length === 0
    ) {
      continue;
    }

    const existing = newestByPath.get(run.path);
    if (existing === undefined || Number(run.id) > Number(existing.id)) {
      newestByPath.set(run.path, run);
    }
  }

  return [...newestByPath.values()]
    .filter(
      (run) =>
        run.conclusion === ACTION_REQUIRED || run.status === ACTION_REQUIRED,
    )
    .map((run) => run.path)
    .sort();
}

export async function loadActionRequiredWorkflowPaths({
  repository,
  headSha,
  requestJson,
}) {
  const workflowRuns = [];

  for (let page = 1; ; page += 1) {
    const url =
      `https://api.github.com/repos/${repository}/actions/runs` +
      `?event=pull_request&head_sha=${encodeURIComponent(headSha)}` +
      `&per_page=${PAGE_SIZE}&page=${page}`;
    const payload = await requestJson(url);
    const pageRuns = workflowRunsFromPage(payload, page, url);
    workflowRuns.push(...pageRuns);
    if (pageRuns.length < PAGE_SIZE)
      return actionRequiredWorkflowPaths(workflowRuns, headSha);
  }
}

export function awaitingApprovalMessage(paths) {
  return (
    `required workflows awaiting maintainer approval: ${[...paths].sort().join(", ")}; ` +
    "approve the listed workflows, then rerun this gate"
  );
}
