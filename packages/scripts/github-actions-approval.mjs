/**
 * Resolves fork workflows that GitHub has held for maintainer approval. Both
 * base-trusted aggregate gates consume this exact-head view before deciding
 * whether absent check runs are genuinely pending.
 */

const ACTION_REQUIRED = "action_required";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

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

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url =
      `https://api.github.com/repos/${repository}/actions/runs` +
      `?event=pull_request&head_sha=${encodeURIComponent(headSha)}` +
      `&per_page=${PAGE_SIZE}&page=${page}`;
    const payload = await requestJson(url);
    const pageRuns = Array.isArray(payload.workflow_runs)
      ? payload.workflow_runs
      : [];
    workflowRuns.push(...pageRuns);
    if (pageRuns.length < PAGE_SIZE) break;
  }

  return actionRequiredWorkflowPaths(workflowRuns, headSha);
}

export function awaitingApprovalMessage(paths) {
  return `required workflows awaiting maintainer approval: ${[...paths].sort().join(", ")}`;
}
