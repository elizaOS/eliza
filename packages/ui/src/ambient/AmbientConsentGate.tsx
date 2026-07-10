/**
 * Explicit per-session ambient consent gate.
 *
 * AMBIENT-MODE-DESIGN §8.1: capture requires an explicit per-session consent
 * action before the first frame; §8.3: show a jurisdiction-neutral two-party
 * reminder at multi-speaker session start (guidance, never a legal shield).
 *
 * This is NOT a dismissible toast — it is a blocking affordance that stands
 * between "idle" and the first capture. It states plainly what starting does
 * (continuous listening, cloud processing) and carries the bystander reminder.
 * The user must actively affirm; there is no pre-checked box, no "remember"
 * (consent is per-session by design). Big tap targets for the LP3.
 */

import { Ear, ShieldAlert } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import {
  AMBIENT_TWO_PARTY_REMINDER,
  ambientConsentAffirmation,
} from "./ambient-consent";
import type { AmbientProcessingLocation } from "./ambient-session-adapter";

export interface AmbientConsentGateProps {
  processingLocation: AmbientProcessingLocation;
  /** Affirm consent for this session (does not itself begin capture). */
  onGrant: () => void;
  className?: string;
}

export function AmbientConsentGate({
  processingLocation,
  onGrant,
  className,
}: AmbientConsentGateProps): React.ReactElement {
  // Single source of truth for the processing-location clause so the headline
  // affirmation and any supporting copy can never contradict each other.
  const affirmation = ambientConsentAffirmation(processingLocation);

  return (
    <section
      data-testid="ambient-consent-gate"
      className={cn(
        "flex flex-col gap-4 border border-border bg-card p-5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Ear
          className="mt-0.5 size-5 shrink-0 text-accent"
          aria-hidden
        />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-txt-strong">
            Start ambient listening
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {affirmation}
          </p>
        </div>
      </div>

      <div
        className="flex items-start gap-3 border-l-2 border-accent bg-accent-subtle px-3 py-2.5"
        data-testid="ambient-two-party-reminder"
      >
        <ShieldAlert
          className="mt-0.5 size-4 shrink-0 text-accent"
          aria-hidden
        />
        <p className="text-xs leading-relaxed text-muted-strong">
          {AMBIENT_TWO_PARTY_REMINDER}
        </p>
      </div>

      <Button
        variant="surfaceAccent"
        size="lg"
        onClick={onGrant}
        data-testid="ambient-consent-grant"
        className="w-full"
      >
        <Ear className="size-4" aria-hidden />I understand — enable listening
      </Button>
      <p className="text-2xs leading-relaxed text-muted/80">
        Consent applies to this session only. Stopping resets it, and starting
        again asks once more.
      </p>
    </section>
  );
}
