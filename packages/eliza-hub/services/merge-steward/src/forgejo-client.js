export class ForgejoApiError extends Error {
  constructor(message, { status, statusText, body } = {}) {
    super(message);
    this.name = "ForgejoApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class ForgejoClient {
  constructor({
    baseUrl,
    token,
    fetchImpl = globalThis.fetch,
    userAgent = "eliza-merge-steward",
  } = {}) {
    if (!baseUrl) {
      throw new TypeError("ForgejoClient requires baseUrl");
    }

    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiBaseUrl = new URL("api/v1/", this.baseUrl);
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
  }

  url(path, query = {}) {
    const normalizedPath = String(path).replace(/^\/+/, "");
    const url = new URL(normalizedPath, this.apiBaseUrl);

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null && item !== "") {
            url.searchParams.append(key, String(item));
          }
        }
        continue;
      }

      url.searchParams.set(key, String(value));
    }

    return url;
  }

  async request(method, path, { query, body, headers } = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new TypeError("ForgejoClient requires a fetch implementation");
    }

    const requestHeaders = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...headers,
    };

    const init = {
      method,
      headers: requestHeaders,
    };

    if (this.token) {
      requestHeaders.Authorization = `token ${this.token}`;
    }

    if (body !== undefined) {
      requestHeaders["Content-Type"] =
        requestHeaders["Content-Type"] || "application/json";
      init.body = serializeBody(body, requestHeaders["Content-Type"]);
    }

    const response = await this.fetchImpl(this.url(path, query), init);
    return parseResponse(response);
  }

  get(path, options) {
    return this.request("GET", path, options);
  }

  post(path, options) {
    return this.request("POST", path, options);
  }

  patch(path, options) {
    return this.request("PATCH", path, options);
  }

  put(path, options) {
    return this.request("PUT", path, options);
  }

  delete(path, options) {
    return this.request("DELETE", path, options);
  }

  listPullRequests(repo, query = {}) {
    return this.get(`${repoPath(repo)}/pulls`, { query });
  }

  getPullRequest(repo, number) {
    return this.get(`${repoPath(repo)}/pulls/${encodeSegment(number)}`);
  }

  listPullRequestFiles(repo, number, query = {}) {
    return this.get(`${repoPath(repo)}/pulls/${encodeSegment(number)}/files`, {
      query,
    });
  }

  listPullRequestCommits(repo, number, query = {}) {
    return this.get(
      `${repoPath(repo)}/pulls/${encodeSegment(number)}/commits`,
      { query },
    );
  }

  listPullRequestReviews(repo, number, query = {}) {
    return this.get(
      `${repoPath(repo)}/pulls/${encodeSegment(number)}/reviews`,
      { query },
    );
  }

  mergePullRequest(repo, number, body = {}) {
    return this.post(`${repoPath(repo)}/pulls/${encodeSegment(number)}/merge`, {
      body,
    });
  }

  listIssueLabels(repo, issueNumber, query = {}) {
    return this.get(
      `${repoPath(repo)}/issues/${encodeSegment(issueNumber)}/labels`,
      { query },
    );
  }

  addIssueLabels(repo, issueNumber, labels) {
    return this.post(
      `${repoPath(repo)}/issues/${encodeSegment(issueNumber)}/labels`,
      {
        body: { labels },
      },
    );
  }

  replaceIssueLabels(repo, issueNumber, labels) {
    return this.put(
      `${repoPath(repo)}/issues/${encodeSegment(issueNumber)}/labels`,
      {
        body: { labels },
      },
    );
  }

  removeIssueLabel(repo, issueNumber, label) {
    return this.delete(
      `${repoPath(repo)}/issues/${encodeSegment(issueNumber)}/labels/${encodeSegment(label)}`,
    );
  }

  listIssueComments(repo, issueNumber, query = {}) {
    return this.get(
      `${repoPath(repo)}/issues/${encodeSegment(issueNumber)}/comments`,
      { query },
    );
  }

  createIssueComment(repo, issueNumber, body) {
    return this.post(
      `${repoPath(repo)}/issues/${encodeSegment(issueNumber)}/comments`,
      {
        body: { body },
      },
    );
  }

  listCommitStatuses(repo, ref, query = {}) {
    return this.get(
      `${repoPath(repo)}/commits/${encodeSegment(ref)}/statuses`,
      { query },
    );
  }

  getCombinedCommitStatus(repo, ref) {
    return this.get(`${repoPath(repo)}/commits/${encodeSegment(ref)}/status`);
  }

  createCommitStatus(repo, sha, body) {
    return this.post(`${repoPath(repo)}/statuses/${encodeSegment(sha)}`, {
      body,
    });
  }

  listBranchProtections(repo, query = {}) {
    return this.get(`${repoPath(repo)}/branch_protections`, { query });
  }

  getBranchProtection(repo, name) {
    return this.get(
      `${repoPath(repo)}/branch_protections/${encodeSegment(name)}`,
    );
  }

  getBranch(repo, branch) {
    return this.get(`${repoPath(repo)}/branches/${encodeSegment(branch)}`);
  }

  listWorkflowRuns(repo, query = {}) {
    return this.get(`${repoPath(repo)}/actions/runs`, { query });
  }

  getWorkflowRun(repo, runId) {
    return this.get(`${repoPath(repo)}/actions/runs/${encodeSegment(runId)}`);
  }
}

export function repoPath({ owner, repo, name } = {}) {
  if (!owner || !(repo || name)) {
    throw new TypeError("Forgejo repo path requires owner and repo");
  }

  return `/repos/${encodeSegment(owner)}/${encodeSegment(repo || name)}`;
}

export function encodeSegment(value) {
  if (value === undefined || value === null || value === "") {
    throw new TypeError("Forgejo path segment must be present");
  }

  return encodeURIComponent(String(value));
}

function normalizeBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

function serializeBody(body, contentType) {
  if (
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof URLSearchParams ||
    body instanceof FormData
  ) {
    return body;
  }

  if (contentType.toLowerCase().includes("application/json")) {
    return JSON.stringify(body);
  }

  return body;
}

async function parseResponse(response) {
  const text = await response.text();
  const contentType = response.headers?.get?.("content-type") || "";
  const body =
    text && contentType.includes("application/json")
      ? JSON.parse(text)
      : text || null;

  if (!response.ok) {
    throw new ForgejoApiError(
      `Forgejo API request failed with ${response.status}`,
      {
        status: response.status,
        statusText: response.statusText,
        body,
      },
    );
  }

  return body;
}
