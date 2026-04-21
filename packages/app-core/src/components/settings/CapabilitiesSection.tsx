import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@elizaos/ui";
import { useCallback, useEffect, useState } from "react";
import { type ComputerUseApprovalMode, client } from "../../api/client";
import { useApp } from "../../state";

export function CapabilitiesSection() {
  const {
    walletEnabled,
    browserEnabled,
    computerUseEnabled,
    setActionNotice,
    setState,
    t,
  } = useApp();
  const [computerUseApprovalMode, setComputerUseApprovalMode] =
    useState<ComputerUseApprovalMode>("full_control");
  const [computerUseModeBusy, setComputerUseModeBusy] = useState(false);

  useEffect(() => {
    if (!computerUseEnabled) {
      return;
    }

    let cancelled = false;
    void client
      .getComputerUseApprovals()
      .then((snapshot) => {
        if (!cancelled) {
          setComputerUseApprovalMode(snapshot.mode);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setComputerUseApprovalMode("full_control");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [computerUseEnabled]);

  const handleComputerUseApprovalModeChange = useCallback(
    async (nextMode: string) => {
      setComputerUseApprovalMode(nextMode as ComputerUseApprovalMode);
      setComputerUseModeBusy(true);
      try {
        const result = await client.setComputerUseApprovalMode(
          nextMode as ComputerUseApprovalMode,
        );
        setComputerUseApprovalMode(result.mode);
        setActionNotice(
          t("settings.sections.capabilities.computerUseModeSaved", {
            defaultValue: `Computer use approval mode set to ${result.mode}.`,
          }),
          "success",
          2600,
        );
      } catch (error) {
        setActionNotice(
          error instanceof Error
            ? error.message
            : t("settings.sections.capabilities.computerUseModeFailed", {
                defaultValue: "Failed to update computer use approval mode.",
              }),
          "error",
          3600,
        );
      } finally {
        setComputerUseModeBusy(false);
      }
    },
    [setActionNotice, t],
  );

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
          <div className="space-y-2">
            <div className="font-medium text-sm">
              {t("settings.sections.capabilities.computerUseModeLabel", {
                defaultValue: "Approval Mode",
              })}
            </div>
            <div className="text-xs text-muted">
              {t("settings.sections.capabilities.computerUseModeHint", {
                defaultValue:
                  "Choose whether computer actions run automatically, only safe reads auto-run, every action requires review, or all actions are paused.",
              })}
            </div>
            <Select
              value={computerUseApprovalMode}
              onValueChange={(value) => {
                void handleComputerUseApprovalModeChange(value);
              }}
              disabled={computerUseModeBusy}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue
                  placeholder={t(
                    "settings.sections.capabilities.computerUseModeLabel",
                    {
                      defaultValue: "Approval Mode",
                    },
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full_control">Full Control</SelectItem>
                <SelectItem value="smart_approve">Smart Approve</SelectItem>
                <SelectItem value="approve_all">Review Every Action</SelectItem>
                <SelectItem value="off">Pause Computer Use</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}
