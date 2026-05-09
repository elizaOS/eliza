import { Button } from "@elizaos/ui";
import { Copy, RefreshCw, Server } from "lucide-react";
import { useMemo } from "react";
import { useApp } from "../../state";
import { buildPairingCodeCommandInfo } from "./pairing-command";

export function PairingCommandHint({ remoteUrl }: { remoteUrl?: string }) {
  const { copyToClipboard, setActionNotice, t } = useApp();
  const commandInfo = useMemo(
    () => buildPairingCodeCommandInfo(remoteUrl),
    [remoteUrl],
  );
  const commandRows = commandInfo.sshCommand
    ? [
        {
          label: t("pairingcommandhint.sshCommandLabel", {
            defaultValue: "From this computer",
          }),
          command: commandInfo.sshCommand,
        },
        {
          label: t("pairingcommandhint.serverCommandLabel", {
            defaultValue: "On the server",
          }),
          command: commandInfo.serverCommand,
        },
      ]
    : [
        {
          label: t("pairingcommandhint.serverCommandLabel", {
            defaultValue: "On the server",
          }),
          command: commandInfo.serverCommand,
        },
      ];

  async function copyCommand(command: string) {
    try {
      await copyToClipboard(command);
      setActionNotice(
        t("pairingcommandhint.copied", {
          defaultValue: "Pairing command copied.",
        }),
        "success",
        2200,
      );
    } catch {
      setActionNotice(
        t("pairingcommandhint.copyFailed", {
          defaultValue: "Could not copy pairing command.",
        }),
        "error",
        3200,
      );
    }
  }

  return (
    <div className="rounded-lg border border-border/60 bg-bg/50 p-4 text-txt shadow-sm">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-bg/80 text-muted">
          <Server className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-txt-strong">
            {t("pairingcommandhint.title", {
              defaultValue: "Get a one-time code",
            })}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            {commandInfo.isLoopback
              ? t("pairingcommandhint.localDescription", {
                  defaultValue:
                    "Run this on the same machine as the agent, then paste the returned code.",
                })
              : t("pairingcommandhint.remoteDescription", {
                  defaultValue:
                    "Ask the server owner to generate a code. If you can SSH into the server, run the first command.",
                })}
          </p>
        </div>
      </div>

      {commandRows.map((row) => (
        <CommandLine
          key={row.command}
          label={row.label}
          command={row.command}
          copyLabel={t("pairingcommandhint.copy", { defaultValue: "Copy" })}
          onCopy={copyCommand}
        />
      ))}

      <div className="mt-3 space-y-1 text-[11px] leading-relaxed text-muted">
        {commandInfo.sshTarget ? (
          <p>
            {t("pairingcommandhint.editSshTargetPrefix", {
              defaultValue:
                "If the app URL is a proxy, CDN, or dashboard domain, replace",
            })}{" "}
            <span className="font-mono text-txt">{commandInfo.sshTarget}</span>{" "}
            {t("pairingcommandhint.editSshTargetSuffix", {
              defaultValue: "with your real SSH user and host.",
            })}
          </p>
        ) : null}
        <p className="flex items-start gap-1.5">
          <RefreshCw className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>
            {t("pairingcommandhint.refreshHint", {
              defaultValue:
                "Codes last 10 minutes. If the countdown is low or expired, run the command again.",
            })}
          </span>
        </p>
        {commandInfo.usesDefaultPort ? (
          <p>
            {t("pairingcommandhint.defaultPortHint", {
              defaultValue:
                "No port was in the URL, so this assumes the agent listens on 2138 locally. Change 2138 if your server uses a custom ELIZA_PORT.",
            })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CommandLine({
  label,
  command,
  copyLabel,
  onCopy,
}: {
  label: string;
  command: string;
  copyLabel: string;
  onCopy: (command: string) => Promise<void>;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p
            style={{
              fontFamily: "'Courier New', 'Courier', 'Monaco', monospace",
            }}
            className="text-[10px] font-semibold uppercase text-muted"
          >
            {label}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-md px-2.5 text-xs font-semibold"
          onClick={() => void onCopy(command)}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
          {copyLabel}
        </Button>
      </div>
      <code className="block max-w-full select-all overflow-x-auto whitespace-pre rounded-md border border-border/60 bg-bg/80 px-3 py-2 font-mono text-[11px] leading-relaxed text-txt">
        {command}
      </code>
    </div>
  );
}
