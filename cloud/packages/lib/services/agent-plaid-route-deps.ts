import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  AgentPlaidConnectorError,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  getPlaidItemInfo,
  isPlaidConfigured,
  syncPlaidTransactions,
} from "@/lib/services/agent-plaid-connector";

export const agentPlaidRouteDeps = {
  requireAuthOrApiKeyWithOrg,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  getPlaidItemInfo,
  isPlaidConfigured,
  syncPlaidTransactions,
  AgentPlaidConnectorError,
};
