/**
 * Ambient mode page — the always-listening capture surface.
 *
 * Composes the capture control (consent → start/pause/stop, indicator, session
 * stats) above the live transcript feed. Backed by {@link useAmbientSession},
 * which drives the pendant capture stack behind the transport adapter (batch
 * today, WS TODO seam) and reuses the pendant transcript store. Flag-gated at
 * the route level — this component only mounts when ambient is enabled.
 *
 * LP3-first: single column, big tap targets, monochrome-safe indicator, no
 * bleeding-edge CSS. Black/white/orange tokens + lucide icons only.
 */

import { Trash2 } from "lucide-react";
import type * as React from "react";
import { Button } from "../ui/button";
import { AmbientCaptureControl } from "../../ambient/AmbientCaptureControl";
import { AmbientTranscriptFeed } from "../../ambient/AmbientTranscriptFeed";
import { useAmbientSession } from "../../ambient/useAmbientSession";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

export function AmbientView(): React.ReactElement {
  const ambient = useAmbientSession();
  const { snapshot } = ambient;

  return (
    <ShellViewAgentSurface viewId="ambient">
      <div className="flex h-full min-h-0 w-full flex-col bg-bg text-txt">
        <header className="border-b border-border px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-txt-strong">
                Ambient
              </h1>
              <p className="mt-1 text-sm text-muted">
                {snapshot.deviceName ?? "Always-listening capture"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={ambient.clear}
              disabled={ambient.segments.length === 0 && !ambient.cacheError}
              data-testid="ambient-clear"
            >
              <Trash2 className="size-4" aria-hidden />
              Clear local view
            </Button>
          </div>
          <div className="mt-4">
            <AmbientCaptureControl
              snapshot={snapshot}
              consent={ambient.consent}
              elapsedMs={ambient.elapsedMs}
              resolvedCount={ambient.resolvedCount}
              pendingCount={ambient.pendingCount}
              onGrantConsent={ambient.grantConsent}
              onStart={ambient.start}
              onPause={ambient.pause}
              onResume={ambient.resume}
              onStop={ambient.stop}
            />
          </div>
          <p className="mt-3 text-xs text-muted">
            Local offline view · this device only. Deleting here clears the local
            cache, not server history.
          </p>
        </header>

        <AmbientTranscriptFeed
          segments={ambient.segments}
          capturing={snapshot.capturing}
          cacheError={ambient.cacheError}
        />
      </div>
    </ShellViewAgentSurface>
  );
}

export default AmbientView;
