/** Retire the single obsolete Pages callback binding after database cutover. */
export const RETIRED_NATIVE_CALLBACK_BINDING =
  "ELIZA_NATIVE_AUTH_CALLBACKS_JSON";
export type PagesRetirementFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

type Stage = "configuration" | "read" | "shape" | "update" | "verify";
export class PagesNativeBindingRetirementError extends Error {
  override readonly name = "PagesNativeBindingRetirementError";
  constructor(readonly stage: Stage) {
    super(`Pages native callback retirement failed (${stage})`);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PagesNativeBindingRetirementError("shape");
  return value as Record<string, unknown>;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

export async function retirePagesNativeCallbackBinding(input: {
  accountId: string;
  token: string;
  project: string;
  environment: "staging" | "production";
  verifyOnly?: boolean;
  expectedCommit?: string;
  fetchImpl?: PagesRetirementFetch;
}): Promise<"removed" | "already-absent" | "verified"> {
  if (
    !/^[a-f0-9]{32}$/.test(input.accountId) ||
    !/^[a-z0-9-]+$/.test(input.project) ||
    !input.token ||
    !["staging", "production"].includes(input.environment) ||
    (input.verifyOnly && !/^[a-f0-9]{40}$/.test(input.expectedCommit ?? ""))
  )
    throw new PagesNativeBindingRetirementError("configuration");
  const environment =
    input.environment === "staging" ? "preview" : "production";
  const url = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/pages/projects/${input.project}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const request = async (
    method: "GET" | "PATCH",
    body?: unknown,
    suffix = "",
  ) => {
    const stage = method === "GET" ? "read" : "update";
    try {
      const response = await fetchImpl(url + suffix, {
        method,
        headers: {
          Authorization: `Bearer ${input.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const payload = object(await response.json());
      if (!response.ok || payload.success !== true)
        throw new PagesNativeBindingRetirementError(stage);
      return payload;
    } catch {
      // error-policy:J1 Provider bodies and request headers can contain secrets.
      throw new PagesNativeBindingRetirementError(stage);
    }
  };
  const deployment = async (project: Record<string, unknown>) => {
    const branch = input.environment === "staging" ? "staging" : "main";
    let selected: Record<string, unknown>;
    if (input.environment === "production")
      selected = object(project.canonical_deployment);
    else {
      const matches: Record<string, unknown>[] = [];
      for (let page = 1; ; page++) {
        const payload = await request(
          "GET",
          undefined,
          `/deployments?env=preview&page=${page}`,
        );
        if (!Array.isArray(payload.result))
          throw new PagesNativeBindingRetirementError("shape");
        for (const value of payload.result) {
          const row = object(value);
          const metadata = object(object(row.deployment_trigger).metadata);
          if (
            metadata.branch === branch &&
            row.environment === environment &&
            Array.isArray(row.aliases) &&
            row.aliases.includes(`https://staging.${input.project}.pages.dev`)
          )
            matches.push(row);
        }
        const total = object(payload.result_info).total_pages;
        if (typeof total !== "number" || !Number.isInteger(total) || total < 0)
          throw new PagesNativeBindingRetirementError("shape");
        if (page >= total) break;
      }
      const match = matches[0];
      if (matches.length !== 1 || !match)
        throw new PagesNativeBindingRetirementError("shape");
      selected = match;
    }
    if (typeof selected.id !== "string" || !/^[a-z0-9-]+$/i.test(selected.id))
      throw new PagesNativeBindingRetirementError("shape");
    const current = object(
      (await request("GET", undefined, `/deployments/${selected.id}`)).result,
    );
    const metadata = object(object(current.deployment_trigger).metadata);
    const stage = object(current.latest_stage);
    if (
      current.id !== selected.id ||
      current.project_name !== input.project ||
      current.environment !== environment ||
      metadata.branch !== branch ||
      stage.name !== "deploy" ||
      stage.status !== "success" ||
      (input.environment === "staging" &&
        (!Array.isArray(current.aliases) ||
          !current.aliases.includes(
            `https://staging.${input.project}.pages.dev`,
          ))) ||
      (input.verifyOnly && metadata.commit_hash !== input.expectedCommit)
    )
      throw new PagesNativeBindingRetirementError("verify");
    return object(current.env_vars);
  };
  const configuration = (project: Record<string, unknown>) => {
    if (project.name !== input.project)
      throw new PagesNativeBindingRetirementError("shape");
    const config = object(object(project.deployment_configs)[environment]);
    const variables =
      config.env_vars === undefined ? {} : object(config.env_vars);
    const hash = config.wrangler_config_hash;
    if (hash !== undefined && hash !== null && typeof hash !== "string")
      throw new PagesNativeBindingRetirementError("shape");
    return { config, variables };
  };
  const project = object((await request("GET")).result);
  const before = configuration(project);
  const deployedVariables = await deployment(project);
  if (input.verifyOnly) {
    if (
      Object.hasOwn(before.variables, RETIRED_NATIVE_CALLBACK_BINDING) ||
      Object.hasOwn(deployedVariables, RETIRED_NATIVE_CALLBACK_BINDING)
    )
      throw new PagesNativeBindingRetirementError("verify");
    return "verified";
  }
  const binding = before.variables[RETIRED_NATIVE_CALLBACK_BINDING];
  if (binding === undefined || binding === null) return "already-absent";
  if (!["plain_text", "secret_text"].includes(String(object(binding).type)))
    throw new PagesNativeBindingRetirementError("shape");

  // Match Wrangler's single-variable PATCH. Never resend the other variables
  // or their values; keep the configuration hash unchanged.
  await request("PATCH", {
    deployment_configs: {
      [environment]: {
        env_vars: { [RETIRED_NATIVE_CALLBACK_BINDING]: null },
        ...(Object.hasOwn(before.config, "wrangler_config_hash")
          ? { wrangler_config_hash: before.config.wrangler_config_hash }
          : {}),
      },
    },
  });
  const after = configuration(object((await request("GET")).result));
  const retained = { ...before.variables };
  delete retained[RETIRED_NATIVE_CALLBACK_BINDING];
  if (
    Object.hasOwn(after.variables, RETIRED_NATIVE_CALLBACK_BINDING) ||
    canonical(retained) !== canonical(after.variables) ||
    before.config.wrangler_config_hash !== after.config.wrangler_config_hash
  )
    throw new PagesNativeBindingRetirementError("verify");
  return "removed";
}

if (import.meta.main) {
  retirePagesNativeCallbackBinding({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_API_TOKEN ?? "",
    project: process.env.PAGES_PROJECT ?? "",
    environment: process.env.TARGET_ENVIRONMENT as "staging" | "production",
    verifyOnly: process.argv.includes("--verify"),
    expectedCommit: process.env.GITHUB_SHA,
  }).then(
    (result) => process.stdout.write(`${result}\n`),
    (error) => {
      process.stderr.write(
        `${error instanceof PagesNativeBindingRetirementError ? error.message : "Pages native callback retirement failed"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
