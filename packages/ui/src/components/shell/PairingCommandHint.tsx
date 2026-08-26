/**
 * Pairing-code helper card for the startup/pairing flow: shows the copyable
 * shell command(s) that mint a one-time pairing code on the agent host. For a
 * loopback URL it shows just the on-server `curl`; for a remote URL it also
 * offers the wrapped `ssh` form and hints where to substitute the real SSH
 * target. Command strings come from `buildPairingCodeCommandInfo`
 * (./pairing-command); this only renders and handles clipboard copy.
 */

import { Copy, Server } from "lucide-react";
import { useMemo } from "react";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { buildPairingCodeCommandInfo } from "./pairing-command";

export function PairingCommandHint({ remoteUrl }: { remoteUrl?: string }) {
  const copyToClipboard = useAppSelector((s) => s.copyToClipboard);
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const t = useAppSelector((s) => s.t);
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
    <Card
      surface="backgroundSubtle"
      border="subtle"
      padding="comfortable"
      tone="text"
    >
      <div className="flex items-start gap-3">
        <Card
          surface="backgroundStrong"
          border="subtle"
          tone="muted"
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center"
        >
          <Server className="size-4" aria-hidden />
        </Card>
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

      <div className="mt-3 space-y-1 text-xs-tight leading-relaxed text-muted">
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
      </div>
    </Card>
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
              fontFamily: "'Poppins', Arial, system-ui, sans-serif",
            }}
            className="text-2xs font-semibold uppercase tracking-wider text-muted"
          >
            {label}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="dense"
          className="shrink-0"
          onClick={() => void onCopy(command)}
        >
          <Copy className="size-3.5" aria-hidden />
          {copyLabel}
        </Button>
      </div>
      <Card asChild surface="backgroundStrong" border="subtle">
        <code className="block max-w-full select-all overflow-x-auto whitespace-pre px-3 py-2 font-mono text-xs-tight leading-relaxed text-txt">
          {command}
        </code>
      </Card>
    </div>
  );
}
