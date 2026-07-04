/**
 * Credentials tab for the organization settings surface (#11332) — the org's
 * team credential pool. Any member can VIEW the (masked) pool and contribute a
 * key; enable/disable is owner/admin; delete is owner/admin or the contributor
 * removing their own key. Mirrors the RBAC enforced by
 * `/api/organizations/credentials*`.
 *
 * "Invite & connect" surfaces a copyable join link with the `connect=1` intent
 * (design §5): the teammate lands on this tab with the contribute modal open
 * right after accepting the invite. The link carries only the hashed-token
 * invite — never any key material.
 *
 * @param props.user - Current user (id + role for RBAC)
 * @param props.autoContribute - Open the contribute modal on mount
 *   (`?contribute=1` connect-link landing)
 */

import { KeyRound, Loader2, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { BrandButton } from "../../cloud-ui";
import { useCloudT } from "../shell/CloudI18nProvider";
import { ContributeCredentialDialog } from "./contribute-credential-dialog";
import { CredentialsList } from "./credentials-list";
import {
  canManageOrg,
  type UserWithOrganizationDto,
} from "./data/cloud-org-types";
import {
  useOrganizationCredentials,
  useRemoveCredential,
  useUpdateCredential,
} from "./data/use-credentials";
import { organizationErrorMessage } from "./data/use-organization";
import { InviteMemberDialog } from "./invite-member-dialog";

interface CredentialsTabProps {
  user: UserWithOrganizationDto;
  autoContribute?: boolean;
}

export function CredentialsTab({
  user,
  autoContribute = false,
}: CredentialsTabProps) {
  const t = useCloudT();
  const [isContributeOpen, setIsContributeOpen] = useState(autoContribute);
  const [isInviteOpen, setIsInviteOpen] = useState(false);

  const canManage = canManageOrg(user.role);

  const credentialsQuery = useOrganizationCredentials();
  const updateCredential = useUpdateCredential();
  const removeCredential = useRemoveCredential();

  const credentials = credentialsQuery.data ?? [];

  const handleToggle = async (credentialId: string, enabled: boolean) => {
    try {
      await updateCredential.mutateAsync({ credentialId, enabled });
      toast.success(
        enabled
          ? t("cloud.credentialsTab.enabled", {
              defaultValue: "Credential enabled",
            })
          : t("cloud.credentialsTab.disabled", {
              defaultValue: "Credential disabled",
            }),
      );
    } catch (error) {
      toast.error(
        organizationErrorMessage(
          error,
          t("cloud.credentialsTab.updateFailed", {
            defaultValue: "Failed to update credential",
          }),
        ),
      );
    }
  };

  const handleRemove = async (credentialId: string) => {
    try {
      await removeCredential.mutateAsync(credentialId);
      toast.success(
        t("cloud.credentialsTab.removed", {
          defaultValue: "Credential removed from the pool",
        }),
      );
    } catch (error) {
      toast.error(
        organizationErrorMessage(
          error,
          t("cloud.credentialsTab.removeFailed", {
            defaultValue: "Failed to remove credential",
          }),
        ),
      );
    }
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header with Contribute + Invite & connect */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base md:text-lg font-mono font-semibold text-white">
            {t("cloud.credentialsTab.title", {
              defaultValue: "Team Credential Pool",
            })}
          </h3>
          <p className="text-xs md:text-sm font-mono text-white/60">
            {t("cloud.credentialsTab.subtitle", {
              defaultValue:
                "Provider API keys your org rotates across. Keys are encrypted; only the last 4 characters are ever shown.",
            })}
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          {canManage && (
            <BrandButton
              type="button"
              variant="outline"
              onClick={() => setIsInviteOpen(true)}
              className="font-mono text-sm md:text-base w-full sm:w-auto"
            >
              <UserPlus className="h-4 w-4" />
              {t("cloud.credentialsTab.inviteAndConnect", {
                defaultValue: "Invite & Connect",
              })}
            </BrandButton>
          )}
          <BrandButton
            type="button"
            variant="primary"
            onClick={() => setIsContributeOpen(true)}
            className="font-mono text-sm md:text-base w-full sm:w-auto"
          >
            <KeyRound className="h-4 w-4" />
            {t("cloud.credentialsTab.contribute", {
              defaultValue: "Contribute Key",
            })}
          </BrandButton>
        </div>
      </div>

      {/* Credentials list */}
      {credentialsQuery.isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : (
        <CredentialsList
          credentials={credentials}
          currentUserId={user.id}
          canManage={canManage}
          onToggle={handleToggle}
          onRemove={handleRemove}
        />
      )}

      {/* Contribute modal */}
      <ContributeCredentialDialog
        isOpen={isContributeOpen}
        onClose={() => setIsContributeOpen(false)}
        onSuccess={() => {
          toast.success(
            t("cloud.credentialsTab.contributed", {
              defaultValue: "Key validated and added to the pool",
            }),
          );
        }}
      />

      {/* Invite & connect (connect=1 join link) */}
      <InviteMemberDialog
        isOpen={isInviteOpen}
        onClose={() => setIsInviteOpen(false)}
        onSuccess={() => {
          toast.success(
            t("cloud.credentialsTab.inviteSent", {
              defaultValue: "Invitation created",
            }),
          );
        }}
        organizationName={user.organization?.name ?? "this organization"}
        connectIntent
      />
    </div>
  );
}
