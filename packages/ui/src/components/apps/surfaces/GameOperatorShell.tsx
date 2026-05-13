import type { FormEvent } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

export type GameOperatorEventTone =
  | "user"
  | "success"
  | "info"
  | "warning"
  | "error";

export interface GameOperatorEvent {
  id: string;
  label: string;
  message: string;
  tone?: GameOperatorEventTone;
  timestamp?: string | number | null;
}

export interface GameOperatorAction {
  id: string;
  label: string;
  command: string;
  testId?: string;
  active?: boolean;
  disabled?: boolean;
}

export interface GameOperatorDetail {
  label: string;
  value: string;
}

export interface GameOperatorShellProps {
  surfaceTestId: string;
  title: string;
  statusLabel: string;
  statusTone?: "live" | "attention" | "idle";
  objective: string | null;
  detailItems?: GameOperatorDetail[];
  primaryActions: GameOperatorAction[];
  suggestedActions?: GameOperatorAction[];
  events: GameOperatorEvent[];
  emptyEventsLabel: string;
  draft: string;
  inputPlaceholder: string;
  sendLabel?: string;
  sendingLabel?: string;
  canSend: boolean;
  sending: boolean;
  chatInputTestId: string;
  chatSendTestId: string;
  noticeTestId?: string;
  variant?: "detail" | "live" | "running";
  onDraftChange: (value: string) => void;
  onSendDraft: () => void;
  onCommand: (command: string) => void;
}

function toneClass(tone: GameOperatorEventTone = "info"): string {
  if (tone === "user") return "border-accent/35 bg-accent/10 text-txt";
  if (tone === "success") return "border-ok/30 bg-ok/10 text-txt";
  if (tone === "warning") return "border-warn/35 bg-warn/10 text-txt";
  if (tone === "error") return "border-danger/35 bg-danger/10 text-txt";
  return "border-border/35 bg-bg/80 text-txt";
}

function statusClass(tone: GameOperatorShellProps["statusTone"]): string {
  if (tone === "live") return "border-ok/30 bg-ok/10 text-ok";
  if (tone === "attention") return "border-warn/35 bg-warn/10 text-warn";
  return "border-border/45 bg-bg-hover/70 text-muted-strong";
}

function formatTimestamp(
  value: string | number | null | undefined,
): string | null {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function GameOperatorShell({
  surfaceTestId,
  title,
  statusLabel,
  statusTone = "idle",
  objective,
  detailItems = [],
  primaryActions,
  suggestedActions = [],
  events,
  emptyEventsLabel,
  draft,
  inputPlaceholder,
  sendLabel = "Send",
  sendingLabel = "Sending",
  canSend,
  sending,
  chatInputTestId,
  chatSendTestId,
  noticeTestId,
  variant = "detail",
  onDraftChange,
  onSendDraft,
  onCommand,
}: GameOperatorShellProps) {
  const latestEvent = events.at(-1) ?? null;
  const visibleEvents = events.slice(-12);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || sending || !canSend) return;
    onSendDraft();
  };

  return (
    <section
      className={`flex min-h-0 flex-col gap-3 ${
        variant === "live" ? "h-full p-3" : ""
      }`}
      data-testid={surfaceTestId}
    >
      <div className="rounded-2xl border border-border/35 bg-card/74 p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex min-h-6 items-center rounded-full border px-2.5 py-1 text-2xs font-medium uppercase tracking-[0.14em] ${statusClass(
              statusTone,
            )}`}
          >
            {statusLabel}
          </span>
          <span className="text-xs font-semibold text-txt">{title}</span>
        </div>
        {objective ? (
          <div className="mt-2 text-xs leading-5 text-muted-strong">
            {objective}
          </div>
        ) : null}
        {detailItems.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {detailItems.map((item) => (
              <span
                key={`${item.label}:${item.value}`}
                className="rounded-full border border-border/35 bg-bg/65 px-2.5 py-1 text-2xs text-muted-strong"
              >
                <span className="text-muted">{item.label}: </span>
                {item.value}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {primaryActions.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={item.active ? "default" : "outline"}
            size="sm"
            className="min-h-9 rounded-xl shadow-sm"
            data-testid={item.testId}
            disabled={!canSend || sending || item.disabled}
            onClick={() => onCommand(item.command)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/35 bg-card/74 shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b border-border/30 px-3 py-2">
          <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-muted">
            Game chat
          </div>
          {latestEvent && noticeTestId ? (
            <div
              className="max-w-44 truncate text-2xs text-muted-strong"
              data-testid={noticeTestId}
              title={latestEvent.message}
            >
              {latestEvent.message}
            </div>
          ) : null}
        </div>
        <div className="min-h-40 flex-1 space-y-2 overflow-y-auto p-3">
          {visibleEvents.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/45 bg-bg/45 px-3 py-4 text-xs leading-5 text-muted-strong">
              {emptyEventsLabel}
            </div>
          ) : (
            visibleEvents.map((event) => {
              const time = formatTimestamp(event.timestamp);
              return (
                <div
                  key={event.id}
                  className={`rounded-xl border px-3 py-2 text-xs leading-5 ${toneClass(
                    event.tone,
                  )}`}
                >
                  <div className="mb-1 flex items-center gap-2 text-2xs uppercase tracking-[0.14em] text-muted">
                    <span>{event.label}</span>
                    {time ? <span>{time}</span> : null}
                  </div>
                  <div>{event.message}</div>
                </div>
              );
            })
          )}
        </div>
        <form className="border-t border-border/30 p-3" onSubmit={handleSubmit}>
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder={inputPlaceholder}
              className="min-h-10 rounded-xl"
              data-testid={chatInputTestId}
              disabled={!canSend}
            />
            <Button
              type="submit"
              className="min-h-10 rounded-xl px-4 shadow-sm"
              data-testid={chatSendTestId}
              disabled={!canSend || sending || !draft.trim()}
            >
              {sending ? sendingLabel : sendLabel}
            </Button>
          </div>
          {suggestedActions.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestedActions.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-8 rounded-xl px-3 shadow-sm"
                  data-testid={item.testId}
                  disabled={!canSend || sending || item.disabled}
                  onClick={() => onCommand(item.command)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          ) : null}
        </form>
      </div>
    </section>
  );
}
