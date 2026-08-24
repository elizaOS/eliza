/**
 * Renders a validated in-chat personal-workspace setup offer and records the
 * continuation before same-app navigation so a successful runtime switch can
 * prefill, but never automatically send, the original request.
 */

import type { CapabilityHandoffRequest } from "@elizaos/shared";
import { useCallback, useState } from "react";
import { useInRouterContext } from "react-router-dom";
import {
  clearPendingCapabilityHandoff,
  rememberPendingCapabilityHandoff,
} from "../../capability-handoff";
import { dispatchNavigateViewRequest } from "../../events";
import { Button } from "../ui/button";

export function CapabilityHandoffBlock({
  request,
}: {
  request: CapabilityHandoffRequest;
}) {
  const [navigationFailed, setNavigationFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const inContainedCloudRouter = useInRouterContext();
  const beginSetup = useCallback(async () => {
    if (opening) return;
    rememberPendingCapabilityHandoff(request);
    setNavigationFailed(false);
    setOpening(true);
    try {
      if (!inContainedCloudRouter) {
        throw new Error("Contained Cloud setup is unavailable in this shell");
      }
      const applied = await dispatchNavigateViewRequest({
        viewId: "cloud",
        viewPath: request.cta.href,
      });
      if (!applied) throw new Error("Contained navigation was not applied");
    } catch {
      // error-policy:J4 setup remains visibly unavailable when the contained
      // management surface cannot load; never escape to an external browser.
      clearPendingCapabilityHandoff();
      setNavigationFailed(true);
    } finally {
      setOpening(false);
    }
  }, [inContainedCloudRouter, opening, request]);

  return (
    <section
      aria-labelledby={`capability-handoff-${request.capabilityId}`}
      className="rounded-sm border border-accent/30 bg-accent/5 p-3 text-sm"
      data-testid="capability-handoff"
    >
      <div
        className="mb-1 font-medium"
        id={`capability-handoff-${request.capabilityId}`}
      >
        Set up {request.label}
      </div>
      <div className="mb-2 whitespace-pre-wrap text-muted">
        {request.reason}
      </div>
      <Button
        aria-busy={opening}
        disabled={opening}
        type="button"
        size="sm"
        onClick={beginSetup}
      >
        {opening ? "Opening…" : request.cta.label}
      </Button>
      {navigationFailed ? (
        <div className="mt-2 text-xs text-danger" role="alert">
          Setup can’t open inside this app yet. Use Eliza on the web and try
          again.
        </div>
      ) : null}
      {request.continuation?.originalIntent ? (
        <div className="mt-2 text-xs text-muted">
          I’ll put your request back in the composer for review when setup is
          done.
        </div>
      ) : null}
    </section>
  );
}
