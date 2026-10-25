/** Defines deletion authorization and explicit completed or reconciliation-pending outcomes. */
import { type AgentSandbox } from "../../../../db/repositories/agent-sandboxes";

export type DeleteAgentResult =
  | { success: true; rowDeleted: true; deletedSandbox: AgentSandbox }
  | {
      success: true;
      rowDeleted: false;
      reconciliationPending: true;
      deletedSandbox: AgentSandbox;
    }
  | { success: false; error: string; retryable?: true };

export type DeleteAuthorization = "user_request" | "billing_request" | "account_deletion";
