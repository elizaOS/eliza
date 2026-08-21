/**
 * Bounded GraphQL-over-HTTPS client for the Linear API. Credentials are pinned
 * to one configured endpoint; redirects are rejected and every production
 * connection uses core's DNS-pinned SSRF-guarded transport. Personal API keys
 * are sent as a raw Authorization value and OAuth tokens as a Bearer value,
 * matching Linear's published authentication contract; the credential never
 * appears in URLs, results, errors, or logs. HTTP status classification stays
 * authoritative, GraphQL error envelopes refine authentication/rate-limit
 * classification, and all response bytes are read under one deadline and one
 * byte limit before schema validation.
 */

import {
  fetchWithSsrfGuard,
  type GuardedFetchOptions,
  isBlockedHostname,
  isPrivateIpAddress,
  logger,
  SsrfBlockedError,
} from "@elizaos/core";
import { LinearError } from "./errors.js";
import {
  graphqlEnvelopeSchema,
  type IssueSearchRequest,
  issueQueryDataSchema,
  issueSearchRequestSchema,
  issuesQueryDataSchema,
  type LinearIssue,
  type LinearIssuePage,
  type LinearTeamPage,
  type LinearViewer,
  type TeamListRequest,
  teamListRequestSchema,
  teamsQueryDataSchema,
  viewerQueryDataSchema,
} from "./types.js";

export const LINEAR_API_ENDPOINT = "https://api.linear.app/graphql";

export type LinearCredential =
  | { type: "apiKey"; value: string }
  | { type: "oauth"; value: string };

export interface LinearClientOptions {
  credential: LinearCredential;
  endpoint?: string;
  timeoutMs?: number;
  responseByteLimit?: number;
  /** Explicit transport seam for deterministic SSRF/adversarial tests only. */
  testTransport?: Pick<
    GuardedFetchOptions,
    "fetchImpl" | "pinnedFetchImpl" | "lookupFn"
  >;
  /** Allows an injected test transport to reach its loopback fake upstream. */
  allowPrivateNetworkForTests?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 25;

const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  priority
  updatedAt
  state { name type }
  team { id key name }
  assignee { id name }
`;

const ISSUES_QUERY = `
query Issues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_QUERY = `
query Issue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;

const TEAMS_QUERY = `
query Teams($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes { id key name }
    pageInfo { hasNextPage endCursor }
  }
}`;

const VIEWER_QUERY = `
query Viewer {
  viewer { id name }
}`;

interface RequestDeadline {
  signal: AbortSignal;
  dispose(): void;
}

function requestDeadline(timeoutMs: number): RequestDeadline {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Linear deadline elapsed", "TimeoutError"),
      ),
    timeoutMs,
  );
  timeout.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  };
}

function observeTeardown(operation: Promise<unknown>, surface: string): void {
  // error-policy:J6 Teardown is intentionally non-blocking; a redacted debug
  // observation keeps cancellation failures visible without delaying results.
  void operation.catch((error) => {
    logger.debug(
      {
        errorName: error instanceof Error ? error.name : typeof error,
        surface,
      },
      "[LinearClient] Response-stream teardown did not complete cleanly",
    );
  });
}

function cancelBody(response: Response, reason: string): void {
  // error-policy:J6 Cancellation is teardown only and must never delay the
  // typed terminal result from an untrusted response stream.
  if (response.body) observeTeardown(response.body.cancel(reason), reason);
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function statusError(response: Response): LinearError {
  if (response.status === 401) {
    return new LinearError("The Linear credential is invalid or has expired.", {
      code: "LINEAR_AUTH_EXPIRED",
      context: { status: response.status },
    });
  }
  if (response.status === 403) {
    return new LinearError("The Linear credential was revoked.", {
      code: "LINEAR_AUTH_REVOKED",
      context: { status: response.status },
    });
  }
  if (response.status === 429) {
    return new LinearError("Linear is rate limiting this workspace.", {
      code: "LINEAR_RATE_LIMITED",
      retryAfterMs: retryAfterMs(response),
      context: { status: response.status },
    });
  }
  if (response.status >= 500) {
    return new LinearError("Linear failed to process the request.", {
      code: "LINEAR_PROVIDER_FAILURE",
      context: { status: response.status },
    });
  }
  return new LinearError("Linear rejected the request.", {
    code: "LINEAR_PROVIDER_REJECTED",
    context: { status: response.status },
  });
}

function graphqlError(codes: readonly string[], status: number): LinearError {
  if (codes.includes("AUTHENTICATION_ERROR")) {
    return new LinearError("The Linear credential is invalid or has expired.", {
      code: "LINEAR_AUTH_EXPIRED",
      context: { status, graphqlCodes: codes },
    });
  }
  if (codes.includes("FORBIDDEN") || codes.includes("ACCESS_DENIED")) {
    return new LinearError("The Linear credential lacks access.", {
      code: "LINEAR_AUTH_REVOKED",
      context: { status, graphqlCodes: codes },
    });
  }
  if (codes.includes("RATELIMITED")) {
    return new LinearError("Linear is rate limiting this workspace.", {
      code: "LINEAR_RATE_LIMITED",
      context: { status, graphqlCodes: codes },
    });
  }
  return new LinearError("Linear rejected the GraphQL operation.", {
    code: "LINEAR_PROVIDER_REJECTED",
    context: { status, graphqlCodes: codes },
  });
}

export class LinearClient {
  private readonly credential: LinearCredential;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly responseByteLimit: number;
  private readonly testTransport?: LinearClientOptions["testTransport"];
  private readonly allowPrivateNetworkForTests: boolean;

  constructor(options: LinearClientOptions) {
    if (!options.credential.value.trim()) {
      throw new LinearError("The Linear credential is empty.", {
        code: "LINEAR_INVALID_INPUT",
      });
    }
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint ?? LINEAR_API_ENDPOINT);
    } catch (error) {
      throw new LinearError("The Linear endpoint is invalid.", {
        code: "LINEAR_INVALID_INPUT",
        cause: error,
      });
    }
    const allowPrivateTest = options.allowPrivateNetworkForTests === true;
    if (allowPrivateTest && !options.testTransport?.fetchImpl) {
      throw new LinearError(
        "Private-network Linear endpoints require an explicit injected test transport.",
        { code: "LINEAR_INVALID_INPUT" },
      );
    }
    if (
      endpoint.protocol !== "https:" &&
      !(allowPrivateTest && endpoint.protocol === "http:")
    ) {
      throw new LinearError("The Linear endpoint must use HTTPS.", {
        code: "LINEAR_INVALID_INPUT",
      });
    }
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new LinearError(
        "The Linear endpoint cannot contain userinfo, query, or fragment data.",
        { code: "LINEAR_INVALID_INPUT" },
      );
    }
    if (
      !allowPrivateTest &&
      (isBlockedHostname(endpoint.hostname) ||
        isPrivateIpAddress(endpoint.hostname))
    ) {
      throw new LinearError("The Linear endpoint is not a public origin.", {
        code: "LINEAR_ENDPOINT_BLOCKED",
      });
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new LinearError(
        `The Linear timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms.`,
        { code: "LINEAR_INVALID_INPUT" },
      );
    }
    const responseByteLimit =
      options.responseByteLimit ?? DEFAULT_RESPONSE_BYTES;
    if (
      !Number.isInteger(responseByteLimit) ||
      responseByteLimit < 1 ||
      responseByteLimit > MAX_RESPONSE_BYTES
    ) {
      throw new LinearError("The Linear response byte limit is invalid.", {
        code: "LINEAR_INVALID_INPUT",
      });
    }
    this.credential = options.credential;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.responseByteLimit = responseByteLimit;
    this.testTransport = options.testTransport;
    this.allowPrivateNetworkForTests = allowPrivateTest;
  }

  async getViewer(): Promise<LinearViewer> {
    const data = await this.execute(
      "Viewer",
      VIEWER_QUERY,
      {},
      viewerQueryDataSchema,
    );
    return data.viewer;
  }

  async listTeams(request: TeamListRequest = {}): Promise<LinearTeamPage> {
    const parsed = teamListRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new LinearError("The Linear team listing request is invalid.", {
        code: "LINEAR_INVALID_INPUT",
        cause: parsed.error,
      });
    }
    const data = await this.execute(
      "Teams",
      TEAMS_QUERY,
      {
        first: parsed.data.limit ?? DEFAULT_PAGE_SIZE,
        after: parsed.data.cursor ?? null,
      },
      teamsQueryDataSchema,
    );
    return {
      teams: data.teams.nodes,
      nextCursor: data.teams.pageInfo.hasNextPage
        ? data.teams.pageInfo.endCursor
        : null,
    };
  }

  async searchIssues(request: IssueSearchRequest): Promise<LinearIssuePage> {
    const parsed = issueSearchRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new LinearError("The Linear issue search request is invalid.", {
        code: "LINEAR_INVALID_INPUT",
        cause: parsed.error,
      });
    }
    const validated = parsed.data;
    const filter: Record<string, unknown> = {};
    if (validated.query) filter.title = { containsIgnoreCase: validated.query };
    if (validated.teamKey) filter.team = { key: { eq: validated.teamKey } };
    if (validated.stateType)
      filter.state = { type: { eq: validated.stateType } };
    if (validated.assignedToMe) filter.assignee = { isMe: { eq: true } };
    const data = await this.execute(
      "Issues",
      ISSUES_QUERY,
      {
        filter,
        first: validated.limit ?? DEFAULT_PAGE_SIZE,
        after: validated.cursor ?? null,
      },
      issuesQueryDataSchema,
    );
    return {
      issues: data.issues.nodes,
      nextCursor: data.issues.pageInfo.hasNextPage
        ? data.issues.pageInfo.endCursor
        : null,
    };
  }

  async getIssue(identifier: string): Promise<LinearIssue | null> {
    const trimmed = identifier.trim();
    if (!trimmed || trimmed.length > 64) {
      throw new LinearError("The Linear issue identifier is invalid.", {
        code: "LINEAR_INVALID_INPUT",
      });
    }
    const data = await this.execute(
      "Issue",
      ISSUE_QUERY,
      { id: trimmed },
      issueQueryDataSchema,
    );
    return data.issue;
  }

  private async execute<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: unknown };
    },
  ): Promise<T> {
    const deadline = requestDeadline(this.timeoutMs);
    try {
      const guarded = await this.fetchResponse(
        operationName,
        query,
        variables,
        deadline,
      );
      try {
        return await this.decodeResponse(
          guarded.response,
          operationName,
          schema,
          deadline,
        );
      } finally {
        await guarded.release();
      }
    } finally {
      deadline.dispose();
    }
  }

  private async fetchResponse(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    deadline: RequestDeadline,
  ): ReturnType<typeof fetchWithSsrfGuard> {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(
      "authorization",
      this.credential.type === "oauth"
        ? `Bearer ${this.credential.value}`
        : this.credential.value,
    );
    try {
      return await fetchWithSsrfGuard({
        url: this.endpoint.href,
        init: {
          method: "POST",
          headers,
          body: JSON.stringify({ query, variables, operationName }),
          redirect: "manual",
          signal: deadline.signal,
        },
        maxRedirects: 0,
        timeoutMs: this.timeoutMs,
        signal: deadline.signal,
        policy: this.allowPrivateNetworkForTests
          ? { allowPrivateNetwork: true }
          : undefined,
        ...this.testTransport,
      });
    } catch (error) {
      // error-policy:J2 Add a typed provider/network classification while
      // preserving the original transport failure as the cause.
      if (
        deadline.signal.aborted ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError"))
      ) {
        throw new LinearError("Linear timed out.", {
          code: "LINEAR_PROVIDER_TIMEOUT",
          cause: error,
          context: { operationName },
        });
      }
      if (error instanceof SsrfBlockedError) {
        throw new LinearError(
          "The Linear endpoint was blocked by network policy.",
          { code: "LINEAR_ENDPOINT_BLOCKED", cause: error },
        );
      }
      throw new LinearError("The Linear connection failed.", {
        code: "LINEAR_PROVIDER_NETWORK",
        cause: error,
        context: { operationName },
      });
    }
  }

  private async readBoundedBody(
    response: Response,
    deadline: RequestDeadline,
  ): Promise<string> {
    const declared = response.headers.get("content-length");
    if (
      declared &&
      /^\d+$/.test(declared) &&
      Number(declared) > this.responseByteLimit
    ) {
      cancelBody(response, "linear declared response exceeded byte limit");
      throw new LinearError("The Linear response exceeded the byte limit.", {
        code: "LINEAR_RESPONSE_TOO_LARGE",
        context: { status: response.status, limit: this.responseByteLimit },
      });
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let body = "";
    let bytes = 0;
    try {
      while (true) {
        const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>(
          (resolve, reject) => {
            const onAbort = () =>
              reject(
                deadline.signal.reason ??
                  new DOMException("Linear deadline elapsed", "TimeoutError"),
              );
            if (deadline.signal.aborted) return onAbort();
            deadline.signal.addEventListener("abort", onAbort, { once: true });
            void reader
              .read()
              .then(resolve, reject)
              .finally(() =>
                deadline.signal.removeEventListener("abort", onAbort),
              );
          },
        );
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > this.responseByteLimit) {
          observeTeardown(
            reader.cancel("linear response exceeded byte limit"),
            "response-too-large",
          );
          throw new LinearError(
            "The Linear response exceeded the byte limit.",
            {
              code: "LINEAR_RESPONSE_TOO_LARGE",
              context: {
                status: response.status,
                limit: this.responseByteLimit,
              },
            },
          );
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      return body;
    } catch (error) {
      if (error instanceof LinearError) throw error;
      if (
        deadline.signal.aborted ||
        (error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError"))
      ) {
        observeTeardown(
          reader.cancel("linear response deadline elapsed"),
          "response-deadline",
        );
        throw new LinearError("Linear timed out.", {
          code: "LINEAR_PROVIDER_TIMEOUT",
          cause: error,
          context: { status: response.status },
        });
      }
      // error-policy:J2 Provider bytes are untrusted; preserve bounded read and
      // UTF-8 failures without retaining or exposing response content.
      throw new LinearError("The Linear response body could not be read.", {
        code: "LINEAR_MALFORMED_RESPONSE",
        cause: error,
        context: { status: response.status },
      });
    } finally {
      try {
        reader.releaseLock();
      } catch (error) {
        // error-policy:J6 A pending untrusted read owns the lock until its
        // non-blocking cancellation settles; terminal classification is fixed.
        logger.debug(
          {
            errorName: error instanceof Error ? error.name : typeof error,
            surface: "reader-release-lock",
          },
          "[LinearClient] Response reader lock remained pending during teardown",
        );
      }
    }
  }

  private async decodeResponse<T>(
    response: Response,
    operationName: string,
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false; error: unknown };
    },
    deadline: RequestDeadline,
  ): Promise<T> {
    if (!response.ok) {
      let codes: string[] = [];
      if (response.status === 400) {
        // Linear reports authentication and rate-limit failures as GraphQL
        // error envelopes on a 400; read the bounded body to refine them.
        try {
          const text = await this.readBoundedBody(response, deadline);
          const envelope = graphqlEnvelopeSchema.safeParse(JSON.parse(text));
          if (envelope.success)
            codes = collectGraphqlCodes(envelope.data.errors);
        } catch {
          // error-policy:J3 Diagnostic bytes are optional; once headers carry
          // an error status, timeout/size/parse failures cannot replace it.
          codes = [];
        }
      } else {
        cancelBody(response, "linear returned an error status");
      }
      if (codes.length > 0) throw graphqlError(codes, response.status);
      throw statusError(response);
    }
    const text = await this.readBoundedBody(response, deadline);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      // error-policy:J2 Provider bytes are untrusted; preserve the JSON parse
      // failure without retaining or exposing the response body.
      throw new LinearError("Linear returned malformed JSON.", {
        code: "LINEAR_MALFORMED_RESPONSE",
        cause: error,
        context: { status: response.status, operationName },
      });
    }
    const envelope = graphqlEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      throw new LinearError("Linear returned an invalid GraphQL envelope.", {
        code: "LINEAR_MALFORMED_RESPONSE",
        cause: envelope.error,
        context: { status: response.status, operationName },
      });
    }
    if (envelope.data.errors && envelope.data.errors.length > 0) {
      throw graphqlError(
        collectGraphqlCodes(envelope.data.errors),
        response.status,
      );
    }
    const parsed = schema.safeParse(envelope.data.data);
    if (!parsed.success) {
      throw new LinearError("The Linear response did not match the contract.", {
        code: "LINEAR_MALFORMED_RESPONSE",
        cause: parsed.error,
        context: { status: response.status, operationName },
      });
    }
    return parsed.data;
  }
}

function collectGraphqlCodes(errors: GraphqlEnvelopeErrors): string[] {
  return [
    ...new Set(
      (errors ?? [])
        .map((entry) => entry.extensions?.code)
        .filter((code): code is string => typeof code === "string"),
    ),
  ];
}

type GraphqlEnvelopeErrors =
  | readonly {
      message?: string;
      extensions?: { code?: string };
    }[]
  | undefined;
