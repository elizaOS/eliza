/// <reference types="bun-types" />
/**
 * E2E Runtime Helper
 *
 * Creates a runtime with REAL services that make actual HTTP calls to n8n API.
 * Uses .env credentials for N8N_HOST and N8N_API_KEY.
 *
 * ⚠️ WARNING: These tests make REAL API calls and modify data on the n8n instance.
 * Use a dedicated test n8n instance, not production!
 */
import { mock } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import {
  N8nWorkflowService,
  N8N_WORKFLOW_SERVICE_TYPE,
} from "../../src/services/n8n-workflow-service";
import { N8nApiClient } from "../../src/utils/api";
import { N8N_CREDENTIAL_STORE_TYPE } from "../../src/types/index";

export interface E2EConfig {
  /** Override n8n host from .env */
  n8nHost?: string;
  /** Override n8n API key from .env */
  n8nApiKey?: string;
}

/**
 * Create a runtime that makes REAL n8n API calls
 */
export function createE2ERuntime(config: E2EConfig = {}) {
  const n8nHost = config.n8nHost || Bun.env.N8N_HOST;
  const n8nApiKey = config.n8nApiKey || Bun.env.N8N_API_KEY;

  if (!n8nHost) {
    throw new Error(
      "N8N_HOST not found in .env or config. Set it to run e2e tests with real API.",
    );
  }

  if (!n8nApiKey) {
    throw new Error(
      "N8N_API_KEY not found in .env or config. Set it to run e2e tests with real API.",
    );
  }

  // Create real N8n service
  const n8nService = new N8nWorkflowService();

  // Minimal runtime mock with real service
  const runtime: IAgentRuntime = {
    agentId: "agent-e2e",
    services: new Map([[N8N_WORKFLOW_SERVICE_TYPE, n8nService]]),
    getService: mock((type: string) => {
      if (type === N8N_WORKFLOW_SERVICE_TYPE) return n8nService;
      if (type === N8N_CREDENTIAL_STORE_TYPE) return null; // No credential store for basic e2e tests
      return null;
    }),
    getSetting: mock((key: string) => {
      if (key === "N8N_HOST") return n8nHost;
      if (key === "N8N_API_KEY") return n8nApiKey;
      return null;
    }),
    getEntityById: mock((userId: string) => {
      return Promise.resolve({ id: userId, names: ["E2E Test User"] });
    }),
    character: { settings: {} },
  } as unknown as IAgentRuntime;

  // Initialize the service (calls static start method logic)
  (n8nService as any).runtime = runtime;
  (n8nService as any).serviceConfig = { apiKey: n8nApiKey, host: n8nHost };
  (n8nService as any).apiClient = new N8nApiClient(n8nHost, n8nApiKey);

  return {
    runtime,
    service: n8nService,
    n8nHost,
  };
}
