/** Private, bounded pinned-CLI transport. No CLI entrypoint or automatic operation. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { OBSERVED_TEMPLATE } from "./pitr-reviewed-stage";
export const PITR_QUERIES = {
  backupContract:
    'query BackupContract { mutation: __type(name: "Mutation") { fields(includeDeprecated: true) { name args { name defaultValue type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } workflow: __type(name: "WorkflowId") { fields(includeDeprecated: true) { name type { kind name ofType { kind name } } } } }',
  volumes:
    "query Volumes($id: String!) { environment(id: $id) { id volumeInstances { edges { node { id volumeId environmentId serviceId mountPath state deletedAt isPendingDeletion sizeMB } } } } }",
  backupList:
    "query BackupList($id: String!) { volumeInstanceBackupList(volumeInstanceId: $id) { id name createdAt expiresAt } }",
  backupCreate:
    "mutation BackupCreate($id: String!, $name: String!) { volumeInstanceBackupCreate(volumeInstanceId: $id, name: $name) { workflowId } }",
  workflowStatus:
    "query WorkflowStatus($id: String!) { workflowStatus(workflowId: $id) { status } }",
  stageTemplate:
    "mutation StageTemplate($input: TemplateDeployV2Input!) { templateDeployV2(input: $input) { projectId workflowId } }",
  environment:
    "query Environment($id: String!) { environment(id: $id) { id config(decryptVariables: false) } }",
  staged:
    "query Staged($id: String!) { environmentStagedChanges(environmentId: $id) { id status patch } }",
  template:
    'query Template { template(code: "postgres-pitr") { id serializedConfig } }',
} as const;
export const PRIVATE_PROVIDER_FAILURES = [
  "private_provider_cleanup_unconfirmed",
  "private_provider_request_unconfirmed",
  "private_provider_input_refused",
  "private_provider_configuration_missing",
  "private_provider_spawn_failed",
  "private_provider_stdin_failed",
  "private_provider_aborted",
  "private_provider_timed_out",
  "private_provider_output_limit",
  "private_provider_descendants_retired",
  "private_provider_cli_exit",
  "private_provider_invalid_json",
  "private_provider_graphql_unknown",
  "private_provider_authentication",
  "private_provider_permission",
  "private_provider_validation",
  "private_provider_graphql_document",
  "private_provider_bad_user_input",
  "private_provider_rate_limit",
  "private_provider_http_client",
  "private_provider_http_server",
] as const;
type Failure = (typeof PRIVATE_PROVIDER_FAILURES)[number];
/** Codes only: never return provider messages, paths, extensions or arbitrary codes. */
function graphqlFailure(value: unknown): Failure | null {
  if (!value || typeof value !== "object" || !("errors" in value)) return null;
  const errors = (value as { errors: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0)
    return "private_provider_graphql_unknown";
  const classes = new Set<Failure>();
  for (const error of errors) {
    const code = error?.extensions?.code;
    classes.add(
      code === "UNAUTHENTICATED"
        ? "private_provider_authentication"
        : code === "FORBIDDEN"
          ? "private_provider_permission"
          : code === "GRAPHQL_VALIDATION_FAILED"
            ? "private_provider_graphql_document"
            : code === "BAD_USER_INPUT"
              ? "private_provider_bad_user_input"
              : code === "TOO_MANY_REQUESTS" || code === "RATE_LIMITED"
                ? "private_provider_rate_limit"
                : "private_provider_graphql_unknown",
    );
  }
  return classes.size === 1
    ? [...classes][0]
    : "private_provider_graphql_unknown";
}
/** Caller must verify CLI5.38.0 and protected canonical source before constructing this transport. */
export function privatePitrApi(
  operation: keyof typeof PITR_QUERIES,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!Object.hasOwn(PITR_QUERIES, operation))
    return Promise.reject(Error("private_provider_configuration_missing"));
  let body: string;
  try {
    body = JSON.stringify(variables);
    if (typeof body !== "string" || Buffer.byteLength(body) > 4 * 1024 * 1024)
      throw Error("invalid_body");
    variables = JSON.parse(body);
    if (!variables || typeof variables !== "object" || Array.isArray(variables))
      throw Error("invalid_body");
  } catch {
    return Promise.reject(Error("private_provider_input_refused"));
  }
  const query = PITR_QUERIES[operation];
  if (operation === "stageTemplate") {
    const value = variables.input;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return Promise.reject(Error("private_stage_input_refused"));
    const input = value as Record<string, unknown>;
    let template: unknown;
    try {
      template =
        typeof input.serializedConfig === "string"
          ? JSON.parse(input.serializedConfig)
          : input.serializedConfig;
    } catch {
      return Promise.reject(Error("private_stage_input_refused"));
    }
    if (
      input.stageOnly !== true ||
      [
        "existingRootServiceId",
        "environmentId",
        "projectId",
        "workspaceId",
        "templateId",
      ].some(
        (key) => typeof input[key] !== "string" || input[key].length === 0,
      ) ||
      template === undefined ||
      createHash("sha256").update(JSON.stringify(template)).digest("hex") !==
        OBSERVED_TEMPLATE
    )
      return Promise.reject(Error("private_stage_input_refused"));
  }
  if (!query || !process.env.RAILWAY_TOKEN || signal?.aborted)
    return Promise.reject(Error("private_provider_configuration_missing"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      "railway",
      ["api", query, "--variables", "@-", "--compact"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        env: {
          PATH: process.env.PATH,
          RAILWAY_TOKEN: process.env.RAILWAY_TOKEN,
          CI: "true",
          NO_COLOR: "1",
        },
      },
    );
    let done = false;
    let stopped = false;
    let bytes = 0;
    let failure: Failure = "private_provider_request_unconfirmed";
    let httpFailure: Failure | null = null;
    let stderrLine = "";
    let discardLine = false;
    const chunks: Buffer[] = [];
    const finish = (
      value?: unknown,
      error = false,
      cleanupUnconfirmed = false,
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error)
        reject(
          Error(
            cleanupUnconfirmed
              ? "private_provider_cleanup_unconfirmed"
              : failure,
          ),
        );
      else resolve(value);
    };
    const stop = () => {
      if (done || stopped) return;
      stopped = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* process already exited */
        }
      }
      if (!child.pid) finish(undefined, true);
    };
    const timer = setTimeout(() => {
      failure = "private_provider_timed_out";
      stop();
    }, 120000);
    const abort = () => {
      failure = "private_provider_aborted";
      stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        failure = "private_provider_output_limit";
        stop();
        return;
      }
      chunks.push(chunk);
    });
    // Inspect only the pinned CLI's exact HTTP-status line in bounded memory.
    // No stderr text is persisted, forwarded or included in errors.
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        failure = "private_provider_output_limit";
        stop();
        return;
      }
      for (const char of chunk.toString("utf8")) {
        if (char === "\n") {
          if (!discardLine) {
            const match =
              /^(?:Error: )?Railway API request failed with HTTP ([45][0-9]{2})(?: [A-Za-z ]+)?\r?$/.exec(
                stderrLine,
              );
            if (match) {
              const status = Number(match[1]);
              httpFailure =
                status === 401
                  ? "private_provider_authentication"
                  : status === 403
                    ? "private_provider_permission"
                    : status === 429
                      ? "private_provider_rate_limit"
                      : status >= 500
                        ? "private_provider_http_server"
                        : "private_provider_http_client";
            }
          }
          stderrLine = "";
          discardLine = false;
        } else if (!discardLine) {
          stderrLine += char;
          if (stderrLine.length > 128) {
            stderrLine = "";
            discardLine = true;
          }
        }
      }
    });
    child.on("error", () => {
      failure = "private_provider_spawn_failed";
      finish(undefined, true);
    });
    child.stdin.on("error", () => {
      failure = "private_provider_stdin_failed";
      stop();
    });
    child.on("close", async (code) => {
      const groupPresent = () => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      };
      const descendants = groupPresent();
      if (descendants) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Verify absence below. */
        }
        const deadline = Date.now() + 5000;
        while (groupPresent() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (groupPresent()) {
          finish(undefined, true, true);
          return;
        }
      }
      if (descendants) {
        failure = "private_provider_descendants_retired";
        finish(undefined, true);
        return;
      }
      if (stopped) {
        finish(undefined, true);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        failure =
          httpFailure ??
          (code !== 0
            ? "private_provider_cli_exit"
            : "private_provider_invalid_json");
        finish(undefined, true);
        return;
      }
      const graphFailure = graphqlFailure(value);
      if (code !== 0 || graphFailure || httpFailure) {
        failure = httpFailure ?? graphFailure ?? "private_provider_cli_exit";
        finish(undefined, true);
      } else finish(value);
    });
    child.stdin.end(body);
  });
}
