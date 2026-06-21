import { Check } from "lucide-react";
import type { CloudHandoffPhase } from "../../events";
import { useCloudHandoffPhase } from "../../hooks/useCloudHandoffPhase";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";

// z-[9999] mirrors Z_SYSTEM_CRITICAL in ../../lib/floating-layers.ts, matching
// the sibling top banners. Kept literal so Tailwind v4's scanner emits it.

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
 * visible instead of silent. While a freshly-provisioned agent's container
 * boots the user chats on the shared adapter; once it's ready the live client
 * swaps over automatically. Renders in document flow like the other top banners
 * and self-dismisses via {@link useCloudHandoffPhase}.
 */
export function CloudHandoffBanner() {
  const handoff = useCloudHandoffPhase();
  if (!handoff) return null;

  const { phase } = handoff;
  const isFailure = phase === "timed-out" || phase === "failed";

  return (
    <div
      role="status"
      aria-live="polite"
      data-window-titlebar-banner="true"
      className={cn(
        "mobile-top-banner shrink-0 z-[9999] flex items-center gap-3 px-4 py-2 text-sm font-medium text-[color:var(--accent-foreground)]",
        isFailure ? "bg-warn" : "bg-accent",
      )}
    >
      {phase === "migrating" ? (
        <Spinner
          size={16}
          className="shrink-0 text-[color:var(--accent-foreground)]"
        />
      ) : isFailure ? null : (
        <Check size={16} className="shrink-0" aria-hidden />
      )}
      <span className="truncate">{MESSAGE[phase]}</span>
    </div>
  );
}
