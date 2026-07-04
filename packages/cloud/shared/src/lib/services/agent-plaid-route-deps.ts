// Coordinates cloud service agent plaid route deps behavior behind route handlers.
import { requireAuthOrApiKeyWithOrg } from "../auth";
import {
  AgentPlaidConnectorError,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  getPlaidItemInfo,
  isPlaidConfigured,
  syncPlaidTransactions,
} from "./agent-plaid-connector";

export const agentPlaidRouteDeps = {
  requireAuthOrApiKeyWithOrg,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  getPlaidItemInfo,
  isPlaidConfigured,
  syncPlaidTransactions,
  AgentPlaidConnectorError,
};
