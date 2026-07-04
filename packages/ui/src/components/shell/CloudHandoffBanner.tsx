/**
 * Renders the shell banner that guides users from local startup into the Cloud
 * handoff flow.
 */
import { Check } from "lucide-react";
import {
  type CloudHandoffPhase,
  dispatchCloudHandoffRetry,
} from "../../events";
import { useCloudHandoffPhase } from "../../hooks/useCloudHandoffPhase";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

const MESSAGE: Record<CloudHandoffPhase, string> = {
  migrating: "Setting up your dedicated agent — you can keep chatting.",
  switched: "You're now on your dedicated agent.",
  "switched-empty": "You're now on your dedicated agent.",
  "timed-out":
    "Your dedicated agent is taking longer — you're still on the shared one.",
  failed:
    "Couldn't switch to your dedicated agent yet — you're still on the shared one.",
};

/**
 * Surfaces the shared→dedicated cloud-agent handoff so the background swap is
 * visible instead of silent. While a freshly-provisioned agent's container boots
 * the user keeps chatting on the shared adapter; once it's ready the live client
 * swaps over automatically.
 *
 * Rendered as a floating toast pill (not an in-flow tinted banner): the chat
 * view is a full-screen overlay with an orange ambient background, so a tinted
 * top banner would sit behind it and any orange-family tint (accent/warn) would
 * blend in. A dark pill below the status bar reads cleanly on any view. The
 * `--warn` spinner / `--ok` check carry the state; it self-dismisses via
 * {@link useCloudHandoffPhase}. On a `timed-out`/`failed` handoff it offers a
 * retry that re-invokes the handoff supervisor.
 */
export function CloudHandoffBanner() {
  const handoff = useCloudHandoffPhase();
  if (!handoff) return null;

  const { phase, agentId } = handoff;
  const isFailure = phase === "timed-out" || phase === "failed";
  const isSuccess = phase === "switched" || phase === "switched-empty";

  return (
    <div
      role="status"
      aria-live="polite"
      // z-[9999] mirrors Z_SYSTEM_CRITICAL in ../../lib/floating-layers.ts so it
      // floats above the chat overlay. Dark bg + safe-area offset are inline so
      // they don't depend on theme tokens (which are orange on the chat view).
      className={cn(
        "fixed left-1/2 z-[9999] flex max-w-[88%] -translate-x-1/2 items-center gap-2",
        "rounded-2xl border border-white/15 px-4 py-2",
        "text-sm font-medium leading-snug text-white",
      )}
      style={{
        top: "calc(var(--safe-area-top, 0px) + 10px)",
        backgroundColor: "rgba(22, 22, 30, 0.96)",
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        {phase === "migrating" ? (
          <Spinner size={15} className="shrink-0 text-[color:var(--warn)]" />
        ) : isSuccess ? (
          <Check
            size={15}
            className="shrink-0 text-[color:var(--ok)]"
            aria-hidden
          />
        ) : null}
        <span className="truncate">{MESSAGE[phase]}</span>
      </span>
      {isFailure ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatchCloudHandoffRetry({ agentId })}
          className="h-6 shrink-0 rounded-sm px-2 text-xs text-white/80 hover:bg-white/10 hover:text-white"
          data-testid="cloud-handoff-retry"
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}
