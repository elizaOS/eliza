/**
 * Renders the prop-driven runtime switcher used by Settings and the coding
 * cockpit to show local, cloud, and remote Eliza agent runtimes.
 */
import { Check, Cloud, HardDrive, Server } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import type { AgentProfile } from "../../state/agent-profile-types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

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
    <section
      data-testid="my-runtimes"
      className={cn("flex flex-col gap-3", className)}
    >
      <h2 className="text-sm font-semibold text-txt">My Runtimes</h2>

      <ul className="flex flex-col gap-2">
        {sorted.map((rt) => {
          const meta = KIND_META[rt.kind];
          const Icon = meta.icon;
          const isActive = rt.id === activeId;
          return (
            <li key={rt.id}>
              <div
                data-testid={`runtime-${rt.id}`}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2.5",
                  isActive ? "border-accent bg-accent-subtle" : "border-border",
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-muted" />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-txt">
                      {rt.label}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                        meta.badge,
                      )}
                    >
                      {meta.label}
                    </span>
                  </span>
                  {rt.apiBase ? (
                    <span className="truncate text-xs text-muted">
                      {rt.apiBase}
                    </span>
                  ) : null}
                </span>
                {isActive ? (
                  <span
                    data-testid={`runtime-${rt.id}-active`}
                    className="ml-auto flex shrink-0 items-center gap-1 text-xs font-semibold text-accent"
                  >
                    <Check className="h-3.5 w-3.5" /> Active
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`runtime-${rt.id}-use`}
                    disabled={busy}
                    onClick={() => onSwitch(rt.id)}
                    className="ml-auto shrink-0"
                  >
                    Use
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {onAddRemote ? (
        <form
          data-testid="add-remote-runtime"
          className="flex flex-col gap-2 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            submitRemote();
          }}
        >
          <span className="text-xs font-semibold text-muted">
            Add a VPS / remote runtime
          </span>
          <Input
            data-testid="add-remote-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. my VPS)"
          />
          <Input
            data-testid="add-remote-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… or http://100.x.y.z:port (tailscale)"
            inputMode="url"
          />
          <Input
            data-testid="add-remote-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Access token (optional)"
            type="password"
          />
          <Button
            type="submit"
            size="sm"
            data-testid="add-remote-submit"
            disabled={!canAdd}
          >
            Add runtime
          </Button>
        </form>
      ) : null}
    </section>
  );
}
