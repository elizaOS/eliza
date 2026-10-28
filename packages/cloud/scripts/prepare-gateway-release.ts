/** Pin a pre-uploaded image while retaining the tracked gateway host contract. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gatewayReleaseLifecycle } from "./gateway-release-lifecycle";

const environment = process.env.TARGET_ENVIRONMENT;
if (environment !== "staging" && environment !== "production") {
  throw new Error("Unsupported gateway environment");
}
const image = process.env.GATEWAY_RELEASE_IMAGE ?? "";
const expectedPrefix = `registry.cloudflare.com/23cf6feaeaa541f6a0675053c33da768/eliza-gateway-webhook-${environment}@sha256:`;
if (
  !image.startsWith(expectedPrefix) ||
  !/^[a-f0-9]{64}$/.test(image.slice(expectedPrefix.length))
) {
  throw new Error(
    "Gateway release requires the selected environment's immutable image",
  );
}
const directory = process.env.RUNNER_TEMP;
if (!directory) throw new Error("RUNNER_TEMP is required");
const config = Bun.TOML.parse(
  readFileSync(
    "packages/cloud/services/gateway-container/cloudflare/wrangler.toml",
    "utf8",
  ),
);
const selected = `webhook-${environment}`;
const target = config.env[selected];
if (
  config.account_id !== process.env.CLOUDFLARE_ACCOUNT_ID ||
  target.name !== `eliza-gateway-webhook-${environment}` ||
  target.containers.length !== 1
) {
  throw new Error(
    "Tracked gateway configuration does not match the release target",
  );
}
const container = { ...target.containers[0], image };
delete container.image_build_context;
delete container.image_vars;
writeFileSync(
  `${directory}/gateway-wrangler.json`,
  JSON.stringify({
    ...gatewayReleaseLifecycle(config, environment),
    main: resolve(
      "packages/cloud/services/gateway-container/cloudflare/worker.ts",
    ),
    env: { [selected]: { ...target, containers: [container] } },
  }),
  { mode: 0o600 },
);
writeFileSync(
  `${directory}/gateway-secrets.json`,
  JSON.stringify({
    GATEWAY_RUNTIME_CONFIG: process.env.GATEWAY_RUNTIME_CONFIG,
  }),
  { mode: 0o600 },
);
