/**
 * Organization domain barrel (app-hosted Eliza Cloud).
 *
 * Members + invites management with RBAC owner > admin > member. Lifted from
 * `@elizaos/cloud-frontend/src/dashboard/settings/_components/.../organization`
 * and rewired onto the app's shared cloud infra (typed `api` client +
 * React-Query + cloud route registry + cloud i18n).
 *
 * Consumers:
 * - the Wave-3 settings agent registers {@link OrganizationSection} (zero-arg,
 *   self-loading) into the settings-section registry.
 * - the cloud router shell mounts the standalone route by side-effect of
 *   importing `./routes` (which calls `registerCloudRoute("dashboard/organization")`).
 *
 * Single-org reality: a user belongs to exactly one organization. Accepting an
 * invite *moves* the invitee to this org (it does not add a second membership);
 * the invite dialog copy surfaces that explicitly.
 */

// Side-effect: register the `dashboard/organization` cloud route.
import "./routes";

export type {
  InviteRole,
  OrganizationDto,
  OrgInviteDto,
  OrgMemberDto,
  UserWithOrganizationDto,
} from "./data/cloud-org-types";
export {
  organizationErrorMessage,
  organizationQueryKeys,
  useCreateInvite,
  useOrganizationInvites,
  useOrganizationMembers,
  useOrganizationUser,
  useRemoveMember,
  useRevokeInvite,
  useUpdateMemberRole,
} from "./data/use-organization";
export { InviteMemberDialog } from "./invite-member-dialog";
export { MembersList } from "./members-list";
export { MembersTab } from "./members-tab";
export { OrganizationPage } from "./OrganizationPage";
export {
  default as OrganizationSectionDefault,
  OrganizationSection,
} from "./OrganizationSection";
export { OrganizationGeneralTab } from "./organization-general-tab";
export { OrganizationTab } from "./organization-tab";
export { PendingInvitesList } from "./pending-invites-list";
