import * as ElizaCore from "@elizaos/core";
import {
  ELIZAOS_ACTION_NAME,
  ELIZAOS_ADAPTER_VERSION,
  ELIZAOS_PLUGIN_NAME,
  createSvsElizaOsPlugin
} from "@svsprotocol/solana/elizaos";

const REQUIRED_ENV = [
  "SVS_SERVER_URL",
  "SVS_BOT_ID",
  "SVS_BOT_POLICY_ID",
  "SVS_BOT_API_KEY",
  "SVS_BOT_REQUEST_SIGNING_SECRET",
  "SVS_BOT_EXPECTED_INTEGRATION_CONTRACT_HASH",
  "SOLANA_RPC_URL"
];

const LIVE_SUBMIT_REQUIRED_ENV = [
  ...REQUIRED_ENV,
  "SVS_SERIALIZED_TRANSACTION_BASE64"
];

export function createSvsVerifiedElizaOsPlugin(env = process.env) {
  assertRequiredEnv(env);

  return createSvsElizaOsPlugin({
    baseUrl: env.SVS_SERVER_URL,
    apiKey: env.SVS_BOT_API_KEY,
    requestSigningSecret: env.SVS_BOT_REQUEST_SIGNING_SECRET,
    expectedIntegrationContractHash: env.SVS_BOT_EXPECTED_INTEGRATION_CONTRACT_HASH,
    botId: env.SVS_BOT_ID,
    policyId: env.SVS_BOT_POLICY_ID,
    rpcUrl: env.SOLANA_RPC_URL,
    waitForProof: env.SVS_WAIT_FOR_PROOF === "true",
    fetchProof: true,
    checkReceiptRegistryChain: true
  });
}

export async function requireSvsVerifiedElizaOsReady(env = process.env) {
  const plugin = createSvsVerifiedElizaOsPlugin(env);
  const action = plugin.actions.find((candidate) => candidate.name === ELIZAOS_ACTION_NAME);

  if (!action) {
    throw new Error(`SVS ElizaOS plugin did not expose ${ELIZAOS_ACTION_NAME}.`);
  }

  const ready = await action.validate();

  if (ready !== true) {
    throw new Error("SVS production readiness check failed.");
  }

  return {
    ok: true,
    pluginName: plugin.name,
    actionName: action.name
  };
}

export async function submitSvsVerifiedElizaOsAction({
  requestId,
  intent,
  serializedTransaction,
  simulation,
  metadata = {}
}, env = process.env) {
  const plugin = createSvsVerifiedElizaOsPlugin(env);
  const action = plugin.actions.find((candidate) => candidate.name === ELIZAOS_ACTION_NAME);

  if (!action) {
    throw new Error(`SVS ElizaOS plugin did not expose ${ELIZAOS_ACTION_NAME}.`);
  }

  const runtime = {};
  const state = { source: "svs-elizaos-example" };
  const message = {
    id: requestId,
    roomId: "svs-elizaos-example-room",
    userId: env.SVS_BOT_ID,
    content: {
      requestId,
      intent,
      serializedTransaction,
      simulation,
      metadata
    }
  };

  return action.handler(runtime, message, state, {
    requestId,
    idempotencyKey: requestId,
    intent,
    serializedTransaction,
    simulation,
    metadata,
    source: {
      agentFramework: "elizaos",
      adapter: ELIZAOS_ADAPTER_VERSION,
      example: "svs-verified-action"
    }
  });
}

export function getSvsElizaOsExampleInfo() {
  return {
    ok: true,
    runtime: "ElizaOS",
    hostPackageImported: typeof ElizaCore === "object",
    hostExportCount: Object.keys(ElizaCore).length,
    adapterVersion: ELIZAOS_ADAPTER_VERSION,
    pluginName: ELIZAOS_PLUGIN_NAME,
    actionName: ELIZAOS_ACTION_NAME,
    packageExport: "@svsprotocol/solana/elizaos",
    liveSubmitOptIn: "SVS_RUN_LIVE_SUBMIT=true"
  };
}

function assertRequiredEnv(env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required SVS env values: ${missing.join(", ")}`);
  }
}

function assertLiveSubmitEnv(env) {
  const missing = LIVE_SUBMIT_REQUIRED_ENV.filter((name) => !env[name]);

  if (missing.length > 0) {
    throw new Error(`Missing required SVS live-submit env values: ${missing.join(", ")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const info = getSvsElizaOsExampleInfo();

  if (process.env.SVS_RUN_LIVE_SUBMIT !== "true") {
    console.log(JSON.stringify({
      ...info,
      status: "dry_run",
      nextAction: "Set SVS_RUN_LIVE_SUBMIT=true only after filling real SVS credentials and a prepared transaction."
    }, null, 2));
    process.exit(0);
  }

  assertLiveSubmitEnv(process.env);

  const result = await submitSvsVerifiedElizaOsAction({
    requestId: `svs-elizaos-${Date.now()}`,
    intent: {
      botId: process.env.SVS_BOT_ID,
      type: "memo",
      summary: "Submit an ElizaOS Solana action through SVS human approval."
    },
    serializedTransaction: process.env.SVS_SERIALIZED_TRANSACTION_BASE64,
    simulation: {
      ok: true,
      source: "provided-by-agent"
    }
  });

  console.log(JSON.stringify(result, null, 2));
}
