/** Read the gateway's sole active Cloudflare version for release receipts. */
import { pathToFileURL } from "node:url";

export async function activeGatewayDeployment(
  environment: string,
  signal?: AbortSignal,
  expected: { versionId?: string; deploymentId?: string } = {},
) {
  if (!["staging", "production"].includes(environment)) {
    throw new Error("Unsupported gateway environment");
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (account !== "23cf6feaeaa541f6a0675053c33da768" || !token?.trim()) {
    throw new Error(
      "The gateway requires the protected Eliza Cloudflare account and credential",
    );
  }
  const service = `eliza-gateway-webhook-${environment}`;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${service}/deployments`,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Cloudflare gateway deployment lookup failed (HTTP ${response.status})`,
    );
  }
  const body = await response.json();
  if (
    body?.success !== true ||
    !Array.isArray(body.result?.deployments) ||
    body.result.deployments.length === 0
  ) {
    throw new Error("Cloudflare did not return a gateway deployment");
  }
  const deployments = body.result.deployments;
  if (
    deployments.some((entry) => !Number.isFinite(Date.parse(entry.created_on)))
  ) {
    throw new Error("Invalid gateway deployment timestamps");
  }
  deployments.sort(
    (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on),
  );
  const active = deployments[0];
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (
    !uuid.test(active.id) ||
    !Array.isArray(active.versions) ||
    active.versions.length !== 1 ||
    active.versions[0].percentage !== 100 ||
    !uuid.test(active.versions[0].version_id)
  ) {
    throw new Error("Gateway must have one fully deployed Cloudflare version");
  }
  if (
    expected.versionId &&
    active.versions[0].version_id !== expected.versionId
  )
    throw new Error("The expected gateway version is no longer active");
  if (expected.deploymentId && active.id !== expected.deploymentId)
    throw new Error("The expected gateway deployment is no longer active");
  const applicationsResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications`,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    },
  );
  if (!applicationsResponse.ok) {
    await applicationsResponse.body?.cancel();
    throw new Error(
      `Gateway image lookup failed (HTTP ${applicationsResponse.status})`,
    );
  }
  const applications = await applicationsResponse.json();
  if (applications?.success !== true || !Array.isArray(applications.result)) {
    throw new Error("Cloudflare did not return gateway applications");
  }
  const matching = applications.result.filter(
    (app) => app.name === `${service}-gatewaycontainer-webhook-${environment}`,
  );
  if (
    matching.length !== 1 ||
    typeof matching[0].configuration?.image !== "string"
  ) {
    throw new Error("The exact gateway container application was not found");
  }
  const image: string = matching[0].configuration.image;
  if (
    !image.startsWith(`registry.cloudflare.com/${account}/`) ||
    !/@sha256:[a-f0-9]{64}$/.test(image)
  ) {
    throw new Error(
      "Gateway application does not use an immutable Cloudflare image",
    );
  }
  return {
    service,
    image,
    deploymentId: active.id as string,
    versionId: active.versions[0].version_id as string,
  };
}

/** Only the image read may converge; a changed deployment or lookup error fails closed. */
export async function verifiedGatewayDeployment(
  environment: string,
  expected: { versionId?: string; deploymentId?: string; image?: string } = {},
  controls: {
    read?: typeof activeGatewayDeployment;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
) {
  const read = controls.read ?? activeGatewayDeployment;
  const now = controls.now ?? Date.now;
  const sleep =
    controls.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = controls.timeoutMs ?? 90_000;
  const intervalMs = controls.intervalMs ?? 5_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 90_000 ||
    !Number.isInteger(intervalMs) ||
    intervalMs <= 0 ||
    intervalMs > timeoutMs
  )
    throw new Error("Invalid gateway image convergence bounds");
  const deadline = now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  let pinned: { versionId: string; deploymentId: string } | undefined;
  for (;;) {
    if (now() >= deadline)
      throw new Error("Gateway image did not converge before the deadline");
    const active = await read(environment, signal, {
      versionId: expected.versionId ?? pinned?.versionId,
      deploymentId: expected.deploymentId ?? pinned?.deploymentId,
    });
    if (expected.versionId && active.versionId !== expected.versionId)
      throw new Error("The expected gateway version is no longer active");
    if (expected.deploymentId && active.deploymentId !== expected.deploymentId)
      throw new Error("The expected gateway deployment is no longer active");
    if (
      pinned &&
      (active.versionId !== pinned.versionId ||
        active.deploymentId !== pinned.deploymentId)
    )
      throw new Error(
        "Gateway deployment identity changed during image convergence",
      );
    if (now() >= deadline)
      throw new Error("Gateway image did not converge before the deadline");
    if (!expected.image || active.image === expected.image) return active;
    // Before a deploy, callers may read metadata without an expected version.
    // Never wait for an image on an unselected Worker deployment.
    if (!expected.versionId)
      throw new Error("The expected gateway image is no longer configured");
    pinned ??= {
      versionId: active.versionId,
      deploymentId: active.deploymentId,
    };
    await sleep(Math.min(intervalMs, deadline - now()));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const active = await verifiedGatewayDeployment(
      process.env.TARGET_ENVIRONMENT ?? "",
      {
        versionId: process.env.EXPECTED_GATEWAY_VERSION,
        deploymentId: process.env.EXPECTED_GATEWAY_DEPLOYMENT,
        image: process.env.EXPECTED_GATEWAY_IMAGE,
      },
    );
    console.log(JSON.stringify(active));
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Gateway deployment verification failed",
    );
    process.exitCode = 1;
  }
}
