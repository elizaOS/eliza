/** Primary-backed verified phone account projection for already authenticated/trusted Cloud subjects. */
import { usersRepository } from "../../db/repositories/users";
import { readOrganizationLifecycleAuthority } from "../services/account-lifecycle-authority";
import { isValidE164, validatePhoneForAPI } from "../utils/phone-normalization";

export async function readActiveVerifiedPhoneAccount(scope: {
  userId: string;
  organizationId: string;
  phoneNumber?: string;
}) {
  const [user, lifecycle] = await Promise.all([
    usersRepository.findByIdForWrite(scope.userId),
    readOrganizationLifecycleAuthority(scope.organizationId),
  ]);
  if (!user || user.id !== scope.userId || user.organization_id !== scope.organizationId
    || !user.is_active || user.is_anonymous || user.deleted_at || user.auth_fenced_at
    || user.account_lifecycle_state !== "active" || user.account_deletion_request_id
    || user.phone_verified !== true || !user.phone_number || !isValidE164(user.phone_number)
    || (scope.phoneNumber !== undefined && user.phone_number !== scope.phoneNumber)
    || !lifecycle?.active || lifecycle.state !== "active" || lifecycle.deletionRequestId) return null;
  const phone = validatePhoneForAPI(user.phone_number);
  if (!phone.valid || phone.normalized !== user.phone_number) return null;
  return {user, organization: {
    id: scope.organizationId,
    is_active: lifecycle.active,
    account_lifecycle_state: lifecycle.state,
    account_deletion_request_id: lifecycle.deletionRequestId,
  }};
}
