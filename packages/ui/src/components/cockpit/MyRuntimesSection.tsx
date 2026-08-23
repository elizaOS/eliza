/**
 * Renders the prop-driven runtime switcher used by Settings and the coding
 * cockpit to show local, cloud, and remote Eliza agent runtimes.
 */
import {
  Check,
  Cloud,
  HardDrive,
  KeyRound,
  Link2,
  Server,
  Tag,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { AgentProfile } from "../../state/agent-profile-types";
import { SettingsInputRow } from "../settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../settings/settings-layout";
import { Button } from "../ui/button";

type RuntimeKind = AgentProfile["kind"];

const KIND_META: Record<
  RuntimeKind,
  { label: string; icon: typeof Cloud; badge: string }
> = {
  local: {
    label: "Local",
    icon: HardDrive,
    badge: "text-muted border-border",
  },
  cloud: {
    label: "Cloud",
    icon: Cloud,
    badge: "text-accent border-accent/30 bg-accent-subtle",
  },
  remote: {
    label: "VPS / Remote",
    icon: Server,
    badge: "text-accent border-accent/30",
  },
};

const KIND_ORDER: RuntimeKind[] = ["local", "cloud", "remote"];

export interface MyRuntimesSectionProps {
  /** The known runtimes (the agent-profile registry). */
  runtimes: AgentProfile[];
  /** The currently-active runtime id. */
  activeId: string | null;
  /** Switch the active runtime (non-destructive re-point — wired by the container). */
  onSwitch: (id: string) => void | Promise<void>;
  /** Add a VPS/remote runtime by URL + token. */
  onAddRemote?: (entry: {
    label: string;
    apiBase: string;
    accessToken?: string;
  }) => void | Promise<void>;
  /** In-flight (disables actions). */
  busy?: boolean;
  className?: string;
}

/**
 * "My Runtimes" — manage and switch between the places an Eliza agent runs:
 * the local embedded runtime, a cloud-dedicated agent, or a VPS exposing a
 * remote URL. Presentational + prop-driven; the cockpit/settings container
 * wires it to the agent-profile registry (`setActiveProfileId` /
 * `addAgentProfile`) and the non-destructive re-point. On a phone the cockpit
 * always drives a remote runtime (local exec is gated off mobile), so this
 * switcher is how you point it at your laptop or cloud agent.
 */
/** @deprecated Catalog-only legacy presentation; use DevicesRuntimesSection. */
export function MyRuntimesSection({
  runtimes,
  activeId,
  onSwitch,
  onAddRemote,
  busy = false,
  className,
}: MyRuntimesSectionProps) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  const sorted = [...runtimes].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );

  const canAdd = !busy && label.trim().length > 0 && url.trim().length > 0;

  const submitRemote = () => {
    if (!canAdd || !onAddRemote) return;
    void onAddRemote({
      label: label.trim(),
      apiBase: url.trim(),
      accessToken: token.trim() || undefined,
    });
    setLabel("");
    setUrl("");
    setToken("");
  };

  return (
    <SettingsStack data-testid="my-runtimes" className={className}>
      <SettingsGroup title="My Runtimes">
        {sorted.map((rt) => {
          const meta = KIND_META[rt.kind];
          const Icon = meta.icon;
          const isActive = rt.id === activeId;
          return (
            <div key={rt.id} data-testid={`runtime-${rt.id}`}>
              <SettingsRow
                icon={Icon}
                active={isActive}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{rt.label}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        meta.badge,
                      )}
                    >
                      {meta.label}
                    </span>
                  </span>
                }
                description={rt.apiBase}
                control={
                  isActive ? (
                    <span
                      data-testid={`runtime-${rt.id}-active`}
                      className="flex shrink-0 items-center gap-1 text-xs font-semibold text-accent"
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden /> Active
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`runtime-${rt.id}-use`}
                      disabled={busy}
                      onClick={() => onSwitch(rt.id)}
                    >
                      Use
                    </Button>
                  )
                }
              />
            </div>
          );
        })}
      </SettingsGroup>

      {onAddRemote ? (
        <form
          data-testid="add-remote-runtime"
          onSubmit={(event) => {
            event.preventDefault();
            submitRemote();
          }}
        >
          <SettingsGroup title="Add a VPS / remote runtime">
            <SettingsInputRow
              agentId="my-runtimes-add-label"
              group="my-runtimes-add"
              icon={Tag}
              label="Label"
              value={label}
              onValueChange={setLabel}
              placeholder="e.g. my VPS"
              testId="add-remote-label"
              autoComplete="off"
            />
            <SettingsInputRow
              agentId="my-runtimes-add-url"
              group="my-runtimes-add"
              icon={Link2}
              label="URL"
              type="url"
              inputMode="url"
              value={url}
              onValueChange={setUrl}
              placeholder="https://… or http://100.x.y.z:port (tailscale)"
              testId="add-remote-url"
              autoComplete="off"
            />
            <SettingsInputRow
              agentId="my-runtimes-add-token"
              group="my-runtimes-add"
              icon={KeyRound}
              label="Access token"
              description="Optional. Leave blank when the runtime does not require one."
              type="password"
              value={token}
              onValueChange={setToken}
              placeholder="Access token (optional)"
              testId="add-remote-token"
              autoComplete="new-password"
            />
            <div className="pt-1">
              <Button
                type="submit"
                size="sm"
                data-testid="add-remote-submit"
                disabled={!canAdd}
              >
                Add runtime
              </Button>
            </div>
          </SettingsGroup>
        </form>
      ) : null}
    </SettingsStack>
  );
}
