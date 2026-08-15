/**
 * Read-only account details: account id, email + verification, and join date.
 * These are labelled 1:1 status rows, not the ProfileForm editor, so they
 * compose SettingsStack / SettingsGroup / SettingsRow.
 */

import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { StatusBadge } from "../../../components/ui/status-badge";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { UserProfile } from "../data/user";

interface AccountDetailsProps {
  user: UserProfile;
}

export function AccountDetails({ user }: AccountDetailsProps) {
  const t = useCloudT();
  const created = user.created_at
    ? new Date(user.created_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <SettingsStack data-testid="cloud-account-details">
      <SettingsGroup
        title={t("cloud.accountDetails.title", {
          defaultValue: "Account details",
        })}
      >
        <SettingsRow
          label={t("cloud.accountDetails.accountId", {
            defaultValue: "Account ID",
          })}
          description={
            <span className="break-all font-mono text-txt-strong">
              {user.id}
            </span>
          }
        />

        {user.email ? (
          <SettingsRow
            label={t("cloud.accountDetails.email", { defaultValue: "Email" })}
            description={
              <span className="break-all text-txt-strong">{user.email}</span>
            }
            control={
              <StatusBadge
                withDot
                variant={user.email_verified ? "success" : "muted"}
                label={
                  user.email_verified
                    ? t("cloud.accountDetails.verified", {
                        defaultValue: "Verified",
                      })
                    : t("cloud.accountDetails.notVerified", {
                        defaultValue: "Unverified",
                      })
                }
              />
            }
          />
        ) : null}

        {created ? (
          <SettingsRow
            label={t("cloud.accountDetails.accountCreated", {
              defaultValue: "Member since",
            })}
            description={<span className="text-txt-strong">{created}</span>}
          />
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  );
}
