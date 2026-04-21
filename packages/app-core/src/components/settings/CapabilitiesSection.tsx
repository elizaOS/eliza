import { Switch } from "@elizaos/ui";
import { useApp } from "../../state";

export function CapabilitiesSection() {
  const { walletEnabled, browserEnabled, computerUseEnabled, setState, t } =
    useApp();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="font-medium text-sm">
            {t("settings.sections.capabilities.walletLabel", {
              defaultValue: "Enable Wallet",
            })}
          </div>
          <div className="text-xs text-muted">
            {t("settings.sections.wallet.enableHint", {
              defaultValue:
                "Show the Wallet tab for managing crypto wallets and token balances",
            })}
          </div>
        </div>
        <Switch
          checked={walletEnabled}
          onCheckedChange={(checked: boolean | "indeterminate") =>
            setState("walletEnabled", !!checked)
          }
          aria-label={t("settings.sections.capabilities.walletLabel", {
            defaultValue: "Enable Wallet",
          })}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="font-medium text-sm">
            {t("settings.sections.capabilities.browserLabel", {
              defaultValue: "Enable Browser",
            })}
          </div>
          <div className="text-xs text-muted">
            {t("settings.sections.capabilities.browserHint", {
              defaultValue:
                "Show the Browser tab for agent-controlled web browsing",
            })}
          </div>
        </div>
        <Switch
          checked={browserEnabled}
          onCheckedChange={(checked: boolean | "indeterminate") =>
            setState("browserEnabled", !!checked)
          }
          aria-label={t("settings.sections.capabilities.browserLabel", {
            defaultValue: "Enable Browser",
          })}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="font-medium text-sm">
            {t("settings.sections.capabilities.computerUseLabel", {
              defaultValue: "Enable Computer Use",
            })}
          </div>
          <div className="text-xs text-muted">
            {t("settings.sections.capabilities.computerUseHint", {
              defaultValue:
                "Allow the agent to control your mouse, keyboard, take screenshots, and automate browsers",
            })}
          </div>
        </div>
        <Switch
          checked={computerUseEnabled}
          onCheckedChange={(checked: boolean | "indeterminate") =>
            setState("computerUseEnabled", !!checked)
          }
          aria-label={t("settings.sections.capabilities.computerUseLabel", {
            defaultValue: "Enable Computer Use",
          })}
        />
      </div>
      {computerUseEnabled && (
        <div className="ml-4 space-y-2 border-l-2 border-border/40 pl-4">
          <div className="text-xs text-muted">
            {t("settings.sections.capabilities.computerUseConfigHint", {
              defaultValue:
                "Computer Use requires Accessibility and Screen Recording permissions on macOS. On Linux, install xdotool. Configure fine-grained permissions in the Permissions section below.",
            })}
          </div>
        </div>
      )}
    </div>
  );
}
