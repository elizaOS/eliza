import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  AgentPaypalConnectorError,
  buildPaypalAuthorizeUrl,
  describePaypalCapability,
  exchangePaypalAuthorizationCode,
  getPaypalIdentity,
  isPaypalConfigured,
  refreshPaypalAccessToken,
  searchPaypalTransactions,
} from "@/lib/services/agent-paypal-connector";

export const agentPaypalRouteDeps = {
  requireAuthOrApiKeyWithOrg,
  buildPaypalAuthorizeUrl,
  describePaypalCapability,
  exchangePaypalAuthorizationCode,
  getPaypalIdentity,
  isPaypalConfigured,
  refreshPaypalAccessToken,
  searchPaypalTransactions,
  AgentPaypalConnectorError,
};
