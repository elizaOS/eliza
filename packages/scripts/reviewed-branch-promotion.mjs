/**
 * Opens branch promotion pull requests without bypassing repository review rules.
 * The request binds the validated source commit and tree; consumers must validate
 * the resulting merge commit again before deploying the destination branch.
 */

const SHA = /^[0-9a-f]{40}$/;

export async function verifyMergedPromotion(api, targetBranch, targetSha) {
  const sourceBranch = { staging: "develop", main: "staging" }[targetBranch];
  if (!sourceBranch || !SHA.test(targetSha))
    throw new Error("invalid promotion destination");
  const pulls = await api.request(
    "GET",
    `/commits/${targetSha}/pulls?per_page=100`,
  );
  if (!Array.isArray(pulls) || pulls.length === 100)
    throw new Error("ambiguous promotion history");
  const matches = pulls.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha === targetSha &&
      pr.base?.ref === targetBranch &&
      pr.head?.ref === sourceBranch &&
      Number.isSafeInteger(pr.head?.repo?.id) &&
      pr.head.repo.id === pr.base?.repo?.id,
  );
  if (matches.length !== 1 || !SHA.test(matches[0].head.sha)) {
    throw new Error(
      `destination must be a merged ${sourceBranch} -> ${targetBranch} PR`,
    );
  }
  const sourceSha = matches[0].head.sha;
  const source = await api.request("GET", `/git/commits/${sourceSha}`);
  const target = await api.request("GET", `/git/commits/${targetSha}`);
  if (!SHA.test(source.tree?.sha) || source.tree.sha !== target.tree?.sha) {
    throw new Error("promotion merge tree differs from reviewed source");
  }
  return { sourceBranch, sourceSha, treeSha: source.tree.sha };
}

export async function requestReviewedPromotion(api, promotion) {
  const { sourceBranch, targetBranch, sourceSha, sourceRunUrl } = promotion;
  if ({ develop: "staging", staging: "main" }[sourceBranch] !== targetBranch) {
    throw new Error("promotion must follow develop -> staging -> main");
  }
  if (!SHA.test(sourceSha)) throw new Error("invalid promotion source SHA");
  const source = await api.request("GET", `/git/ref/heads/${sourceBranch}`);
  if (source.object?.sha !== sourceSha) return { action: "stale" };
  const commit = await api.request("GET", `/git/commits/${sourceSha}`);
  if (!SHA.test(commit.tree?.sha))
    throw new Error("promotion source tree unavailable");
  const repository = await api.request("GET", "");
  const owner = repository.owner?.login;
  if (typeof owner !== "string" || !/^[A-Za-z0-9-]+$/.test(owner))
    throw new Error("promotion repository owner unavailable");
  const history = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api.request(
      "GET",
      `/pulls?state=closed&base=${targetBranch}&head=${encodeURIComponent(`${owner}:${sourceBranch}`)}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch))
      throw new Error("invalid closed promotion history");
    history.push(...batch);
    if (batch.length < 100) break;
    if (page === 100)
      throw new Error("promotion history exceeds pagination budget");
  }
  for (const prior of history) {
    if (
      !prior.merged_at ||
      prior.head?.sha !== sourceSha ||
      prior.head.ref !== sourceBranch ||
      prior.base?.ref !== targetBranch ||
      !Number.isSafeInteger(prior.head?.repo?.id) ||
      prior.head.repo.id !== prior.base?.repo?.id ||
      !SHA.test(prior.merge_commit_sha)
    )
      continue;
    const target = await api.request("GET", `/git/ref/heads/${targetBranch}`);
    if (!SHA.test(target.object?.sha))
      throw new Error("promotion destination ref unavailable");
    const comparison = await api.request(
      "GET",
      `/compare/${prior.merge_commit_sha}...${target.object.sha}`,
    );
    if (["ahead", "identical"].includes(comparison.status)) {
      const merged = await api.request(
        "GET",
        `/git/commits/${prior.merge_commit_sha}`,
      );
      if (merged.tree?.sha !== commit.tree.sha)
        throw new Error("completed promotion changed the reviewed source tree");
      return {
        action: "already-promoted",
        number: prior.number,
        sourceSha,
        treeSha: commit.tree.sha,
      };
    }
  }
  const pulls = await api.request(
    "GET",
    `/pulls?state=open&base=${targetBranch}&per_page=100`,
  );
  if (!Array.isArray(pulls))
    throw new Error("invalid promotion pull request response");
  // A full page may hide an existing request. Fail rather than create a duplicate.
  if (pulls.length === 100)
    throw new Error("promotion pull request search requires pagination");
  const matches = pulls.filter(
    (pr) =>
      pr.head?.ref === sourceBranch &&
      Number.isSafeInteger(pr.head?.repo?.id) &&
      pr.head.repo.id === pr.base?.repo?.id,
  );
  if (matches.length > 1)
    throw new Error("multiple open promotion pull requests");
  const body = [
    `Promote the verified ${sourceBranch} branch to ${targetBranch}.`,
    "",
    `Validated source: \`${sourceSha}\`.`,
    `Source tree: \`${commit.tree.sha}\`.`,
    `Validation: ${sourceRunUrl}`,
    "",
    "A maintainer with write access must select Approve workflows to run in this PR when GitHub requests approval. Wait for All Tests Passed on the current PR commit, then obtain the required review before merging. The resulting destination commit must pass full validation before deployment.",
  ].join("\n");
  const existing = matches[0];
  if (existing && existing.head.sha !== sourceSha) return { action: "stale" };
  const current = await api.request("GET", `/git/ref/heads/${sourceBranch}`);
  if (current.object?.sha !== sourceSha) return { action: "stale" };
  const pr = existing
    ? await api.request("PATCH", `/pulls/${existing.number}`, { body })
    : await api.request("POST", "/pulls", {
        base: targetBranch,
        head: sourceBranch,
        title: `Promote ${sourceBranch} to ${targetBranch}`,
        body,
      });
  if (!Number.isSafeInteger(pr.number) || !pr.html_url) {
    throw new Error("promotion pull request identity unavailable");
  }
  return {
    action: "awaiting-review",
    number: pr.number,
    url: pr.html_url,
    sourceSha,
    treeSha: commit.tree.sha,
  };
}
