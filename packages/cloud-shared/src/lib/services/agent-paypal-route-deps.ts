import { requireAuthOrApiKeyWithOrg } from "../auth";
import {
  AgentPaypalConnectorError,
  buildPaypalAuthorizeUrl,
  describePaypalCapability,
  exchangePaypalAuthorizationCode,
  getPaypalIdentity,
  isPaypalConfigured,
  refreshPaypalAccessToken,
  searchPaypalTransactions,
} from "./agent-paypal-connector";

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
