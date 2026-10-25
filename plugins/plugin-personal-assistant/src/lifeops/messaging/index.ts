/** Barrel for owner send policy: the approval gate LifeOps applies before dispatching outbound messages on the owner's behalf. */
export {
  createOwnerSendPolicy,
  OWNER_SEND_APPROVAL_TASK_NAME,
  registerOwnerSendApprovalWorker,
} from "./owner-send-policy.js";

// LifeOps owns owner send policy. Message transport adapters stay exported by
// their connector plugins and are registered from those packages in plugin.ts.
