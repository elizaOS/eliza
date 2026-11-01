/** Fail-closed Cloudflare readback of the adopted production admission namespace. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// The existing production namespace. A transfer moves its owner, never its ID.
export const PRODUCTION_ADMISSION_NAMESPACE_ID =
  "9e1a8820e95d4dcaa5867c0e37ea581b";

type CloudflareRead = (path: string) => Promise<{
  result?: unknown;
  result_info?: { total_count?: number };
}>;
type Binding = Record<string, unknown>;

async function activeVersion(read: CloudflareRead, script: string) {
  const deployments = (
    (await read(`/workers/scripts/${script}/deployments`)).result as {
      deployments?: {
        created_on: string;
        versions?: { version_id: string; percentage: number }[];
      }[];
    }
  )?.deployments;
  if (!deployments?.length)
    throw new Error(`${script} has no Cloudflare deployment`);
  const [active] = deployments.toSorted(
    (left, right) => Date.parse(right.created_on) - Date.parse(left.created_on),
  );
  if (active.versions?.length !== 1 || active.versions[0].percentage !== 100)
    throw new Error(`${script} must serve exactly one version at 100%`);
  const version = (
    await read(
      `/workers/scripts/${script}/versions/${active.versions[0].version_id}`,
    )
  ).result as { id?: string; resources?: { bindings?: Binding[] } };
  return { id: version?.id, bindings: version?.resources?.bindings ?? [] };
}

/** The namespace ID is the identity; the owner script shows which side serves it. */
function requireGateBinding(
  bindings: Binding[],
  script: string,
  owner: string,
) {
  const matches = bindings.filter(
    (binding) => binding.name === "INFERENCE_ADMISSION_GATES",
  );
  if (
    matches.length !== 1 ||
    matches[0].type !== "durable_object_namespace" ||
    matches[0].class_name !== "InferenceAdmissionGate" ||
    matches[0].namespace_id !== PRODUCTION_ADMISSION_NAMESPACE_ID ||
    (matches[0].script_name ?? script) !== owner
  )
    throw new Error(
      `${script} must bind the existing admission namespace served by ${owner}`,
    );
}

function requireCommit(bindings: Binding[], script: string, commit?: string) {
  const deployed = bindings.find(
    (binding) =>
      binding.name === "ELIZA_DEPLOY_COMMIT" && binding.type === "plain_text",
  )?.text;
  if (deployed !== commit)
    throw new Error(`${script} does not serve the released commit`);
}

/**
 * Proves the steady state a release may republish: the API reaches the
 * existing namespace through the target, the target's local binding resolves
 * that same namespace, and no second admission namespace exists. `admission`
 * and `api` additionally require the released commit on each Worker.
 */
export async function verifyAdoptedProductionAdmission(
  read: CloudflareRead,
  options: {
    api: string;
    target: string;
    stage: "before" | "admission" | "api";
    commit?: string;
  },
) {
  const namespaces: {
    id: string;
    class: string;
    script: string;
    use_sqlite?: boolean;
  }[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const body = await read(
      `/workers/durable_objects/namespaces?per_page=100&page=${page}`,
    );
    const batch = body.result as typeof namespaces;
    if (!Array.isArray(batch))
      throw new Error("Cloudflare did not return namespaces");
    namespaces.push(...batch);
    if (
      !batch.length ||
      namespaces.length >= (body.result_info?.total_count ?? 0)
    )
      break;
  }
  const existing = namespaces.filter(
    (namespace) => namespace.id === PRODUCTION_ADMISSION_NAMESPACE_ID,
  );
  if (
    existing.length !== 1 ||
    existing[0].class !== "InferenceAdmissionGate" ||
    existing[0].use_sqlite !== true
  )
    throw new Error("The existing SQLite admission namespace is not present");
  if (
    namespaces.some(
      (namespace) =>
        namespace.id !== PRODUCTION_ADMISSION_NAMESPACE_ID &&
        namespace.class === "InferenceAdmissionGate" &&
        [options.api, options.target].includes(namespace.script),
    )
  )
    throw new Error("A second production admission namespace exists");
  const api = await activeVersion(read, options.api);
  requireGateBinding(api.bindings, options.api, options.target);
  const target = await activeVersion(read, options.target);
  requireGateBinding(target.bindings, options.target, options.target);
  if (options.stage !== "before")
    requireCommit(target.bindings, options.target, options.commit);
  if (options.stage === "api")
    requireCommit(api.bindings, options.api, options.commit);
  return {
    namespace: PRODUCTION_ADMISSION_NAMESPACE_ID,
    namespaceScript: existing[0].script,
    apiVersion: api.id,
    targetVersion: target.id,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { values } = parseArgs({
      options: { stage: { type: "string" }, commit: { type: "string" } },
    });
    const stage = values.stage;
    if (stage !== "before" && stage !== "admission" && stage !== "api")
      throw new Error("--stage must be before, admission or api");
    if (stage !== "before" && !/^[0-9a-f]{40}$/.test(values.commit ?? ""))
      throw new Error("--commit must be the released 40-character SHA");
    const config = (path: string) =>
      Bun.TOML.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as {
        account_id?: string;
        env?: { production?: { name?: string } };
      };
    const apiConfig = config("../api/wrangler.toml");
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (account !== apiConfig.account_id || !token?.trim())
      throw new Error(
        "Readback requires the protected Eliza Cloudflare account and credential",
      );
    const read: CloudflareRead = async (path) => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
        {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `Cloudflare readback failed (HTTP ${response.status}): ${path}`,
        );
      }
      const body = await response.json();
      if (body?.success !== true)
        throw new Error(`Cloudflare readback was not successful: ${path}`);
      return body;
    };
    const receipt = await verifyAdoptedProductionAdmission(read, {
      api: apiConfig.env?.production?.name ?? "",
      target:
        config("../admission-worker/wrangler.toml").env?.production?.name ?? "",
      stage,
      commit: values.commit,
    });
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Production admission readback failed",
    );
    process.exitCode = 1;
  }
}
