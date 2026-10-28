/** Validate protected release inputs, then prove the live gateway received them. */
import { PROOF_SETTINGS } from "../services/gateway-container/cloudflare/configuration-proof.ts";
import { verifyCloudflareGatewayConfiguration } from "./verify-cloudflare-gateway-configuration.ts";
import { verifyWebhookGatewaySecretMatch } from "./verify-webhook-gateway-binding.ts";

try {
  const parsed: unknown = JSON.parse(
    process.env.GATEWAY_RUNTIME_CONFIG ?? "null",
  );
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Protected gateway runtime configuration is missing");
  }
  if (Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error("Protected gateway runtime settings must be strings");
  }
  const config = parsed as Record<string, string>;
  for (const [name, workerValue] of [
    ["GATEWAY_BOOTSTRAP_SECRET", process.env.GATEWAY_WEBHOOK_BOOTSTRAP_SECRET],
    [
      "ELIZA_APP_WEBHOOK_GATEWAY_SECRET",
      process.env.ELIZA_APP_WEBHOOK_GATEWAY_SECRET,
    ],
  ]) {
    const result = verifyWebhookGatewaySecretMatch({
      workerSecretValue: workerValue,
      gatewaySecretValue: config[name],
      bindingName: name,
    });
    if (!result.ok) throw new Error(result.error);
  }
  const settings: Record<string, string> = {};
  for (const name of PROOF_SETTINGS) {
    if (!config[name]?.trim())
      throw new Error(`Required gateway setting is missing: ${name}`);
    settings[name] = config[name];
  }
  const sourceSha = process.env.GITHUB_SHA ?? "";
  if (!/^[a-f0-9]{40}$/.test(sourceSha))
    throw new Error("Exact gateway source SHA is required");
  if (!process.argv.includes("--candidate-only")) {
    await verifyCloudflareGatewayConfiguration({
      environment: process.env.TARGET_ENVIRONMENT ?? "",
      origin: process.env.GATEWAY_WEBHOOK_URL ?? "",
      bootstrapSecret: config.GATEWAY_BOOTSTRAP_SECRET,
      settings,
      sourceSha,
    });
  }
  console.log(
    "Gateway protected settings verified; no secret values or digests logged.",
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Gateway configuration verification failed",
  );
  process.exitCode = 1;
}
