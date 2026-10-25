/**
 * Link card from the Security section to the API-keys settings section
 * (`/settings#cloud-api-keys`).
 */

import { KeyRound } from "lucide-react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { useCloudT } from "../../shell/CloudI18nProvider";

export function ApiKeysLink() {
  const t = useCloudT();
  return (
    <SettingsStack data-testid="cloud-api-keys-link">
      <SettingsGroup>
        <SettingsRow
          icon={KeyRound}
          label={t("cloud.apiKeysLink.title", { defaultValue: "API keys" })}
          description={t("cloud.apiKeysLink.description", {
            defaultValue:
              "Manage long-lived keys, their scopes, and per-key audit history.",
          })}
          control={
            <a
              href="#cloud-api-keys"
              className="text-sm font-medium text-accent underline-offset-2 hover:underline"
            >
              {t("cloud.apiKeysLink.manageKeys", {
                defaultValue: "Manage keys",
              })}
            </a>
          }
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
