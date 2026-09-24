/** Canonical table set supplied to Drizzle adapters and runtime migrations. */
import { agentTable } from "./schema/agent";
import { approvalDispatchControlTable } from "./schema/approvalDispatchControl";
import { approvalRequestTable } from "./schema/approvalRequests";
import { authAuditEventTable } from "./schema/authAuditEvent";
import { authBootstrapJtiSeenTable } from "./schema/authBootstrapJti";
import { authIdentityCreatedAtDefault, authIdentityTable } from "./schema/authIdentity";
import { authOwnerBindingTable } from "./schema/authOwnerBinding";
import { authOwnerLoginTokenTable } from "./schema/authOwnerLoginToken";
import { authSessionTable } from "./schema/authSession";
import { cacheTable } from "./schema/cache";
import { channelTable } from "./schema/channel";
import { channelParticipantsTable } from "./schema/channelParticipant";
import { componentTable } from "./schema/component";
import {
  connectorAccountAuditEventsTable,
  connectorAccountCredentialsTable,
  connectorAccountsTable,
  oauthFlowsTable,
} from "./schema/connectorAccounts";
import { embeddingTable } from "./schema/embedding";
import { entityTable } from "./schema/entity";
import {
  entityIdentityTable,
  entityMergeCandidateTable,
  factCandidateTable,
} from "./schema/entityIdentity";
import {
  identityAuthorityStateTable,
  identityCanonicalRedirectTable,
  identityClaimTable,
  identityMergeConfirmationTable,
  identityMergeJournalTable,
  identityPersonLinkAttestationTable,
} from "./schema/identityAuthority";
import { logTable } from "./schema/log";
import { longTermMemories } from "./schema/longTermMemories";
import {
  membershipAuthorityJournalTable,
  membershipAuthorityScopeTable,
  membershipAuthorityTable,
} from "./schema/membershipAuthority";
import { memoryTable } from "./schema/memory";
import { memoryAccessLogs } from "./schema/memoryAccessLogs";
import { messageTable } from "./schema/message";
import { messageServerTable } from "./schema/messageServer";
import { messageServerAgentsTable } from "./schema/messageServerAgent";
import { pairingAllowlistTable } from "./schema/pairingAllowlist";
import { pairingRequestTable } from "./schema/pairingRequest";
import { participantTable } from "./schema/participant";
import { relationshipTable } from "./schema/relationship";
import { roomTable } from "./schema/room";
import { serverTable } from "./schema/server";
import { sessionSummaries } from "./schema/sessionSummaries";
import { taskTable } from "./schema/tasks";
import { worldTable } from "./schema/world";
import { worldRoleAuditTable } from "./schema/worldRoleAudit";

export const schema = {
  agentTable,
  approvalDispatchControlTable,
  approvalRequestTable,
  authAuditEventTable,
  authBootstrapJtiSeenTable,
  authIdentityCreatedAtDefault,
  authIdentityTable,
  authOwnerBindingTable,
  authOwnerLoginTokenTable,
  authSessionTable,
  cacheTable,
  channelTable,
  channelParticipantsTable,
  componentTable,
  connectorAccountAuditEventsTable,
  connectorAccountCredentialsTable,
  connectorAccountsTable,
  oauthFlowsTable,
  embeddingTable,
  entityTable,
  entityIdentityTable,
  entityMergeCandidateTable,
  factCandidateTable,
  identityAuthorityStateTable,
  identityCanonicalRedirectTable,
  identityClaimTable,
  identityMergeConfirmationTable,
  identityMergeJournalTable,
  identityPersonLinkAttestationTable,
  logTable,
  longTermMemories,
  membershipAuthorityJournalTable,
  membershipAuthorityScopeTable,
  membershipAuthorityTable,
  memoryTable,
  memoryAccessLogs,
  messageTable,
  messageServerTable,
  messageServerAgentsTable,
  pairingAllowlistTable,
  pairingRequestTable,
  participantTable,
  relationshipTable,
  roomTable,
  serverTable,
  sessionSummaries,
  taskTable,
  worldTable,
  worldRoleAuditTable,
};
