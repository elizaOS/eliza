/**
 * Inline connector-setup widget: renders a connector's setup inside the shared
 * `ChatWidgetShell` with progressive disclosure — required/unset ("minimal")
 * fields up front, the rest behind an "Advanced" dropdown. It starts expanded
 * while the connector is unconfigured and auto-collapses to a "Connected"
 * summary once every required param is set (the shell owns that transition).
 *
 * Consumed via the inline-widget registry (`[CONNECTOR:<id>]` marker) from both
 * `MessageContent` and the overlay renderer. Secrets never appear as plain
 * in-chat inputs: each field is a labelled row, and the primary action hands
 * off to the connector's real setup path via `onSetup` (the sensitive-request /
 * hosted-page flow), so no secret value travels through the transcript.
 *
 * The component is wrapped in `memo` so a user opening the Advanced dropdown (or
 * toggling the shell) re-renders only this widget subtree, never the transcript
 * — the render-count perf lock covers a transcript full of these.
 */

import type { PluginParam } from "@elizaos/shared";
import { Cable } from "lucide-react";
import { memo, useState } from "react";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { ChatWidgetShell } from "./chat-widget-shell";
import {
  deriveConnectorFieldTiers,
  isConnectorConfigured,
} from "./connector-field-tiers";

export interface ConnectorSetupWidgetProps {
  /** Connector/plugin id, e.g. `discord`. */
  id: string;
  /** Human label shown in the header. */
  name: string;
  /** Parameter schema (never values) driving the tiers + connected state. */
  params: PluginParam[];
  /** Kick off the connector's real setup path (sensitive-request flow). */
  onSetup: (connectorId: string) => void;
}

function FieldRow({ param }: { param: PluginParam }) {
  return (
    <li className="flex items-center justify-between gap-2 py-1 text-xs">
      <span className="truncate text-muted">{param.label ?? param.key}</span>
      {param.isSet ? (
        <span className="shrink-0 text-2xs text-muted/70">set</span>
      ) : param.required ? (
        <span className="shrink-0 text-2xs text-primary">required</span>
      ) : (
        <span className="shrink-0 text-2xs text-muted/70">optional</span>
      )}
    </li>
  );
}

function ConnectorSetupWidgetImpl({
  id,
  name,
  params,
  onSetup,
}: ConnectorSetupWidgetProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { minimal, advanced } = deriveConnectorFieldTiers(params);
  const configured = isConnectorConfigured(params);

  const status = (
    <Badge variant={configured ? "default" : "secondary"}>
      {configured ? "Connected" : "Setup"}
    </Badge>
  );

  const summary = (
    <span className="truncate">
      {configured ? `${name} connected` : `${name} needs setup`}
    </span>
  );

  return (
    <ChatWidgetShell
      testId={`connector-widget-${id}`}
      title={name}
      icon={<Cable aria-hidden />}
      status={status}
      complete={configured}
      summary={summary}
    >
      <ul className="mb-2 space-y-0.5">
        {minimal.map((param) => (
          <FieldRow key={param.key} param={param} />
        ))}
      </ul>

      {advanced.length > 0 ? (
        <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={`connector-widget-${id}-advanced-toggle`}
              className="h-auto w-full justify-start rounded-sm bg-transparent px-0 py-1 text-2xs text-muted transition-colors hover:bg-transparent hover:text-txt"
            >
              {showAdvanced ? "Hide advanced" : "Advanced"} ({advanced.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent
            data-testid={`connector-widget-${id}-advanced-body`}
          >
            <ul className="space-y-0.5">
              {advanced.map((param) => (
                <FieldRow key={param.key} param={param} />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {!configured ? (
        <Button
          type="button"
          size="sm"
          onClick={() => onSetup(id)}
          data-testid={`connector-widget-${id}-setup`}
          className="mt-2 w-full"
        >
          Set up securely
        </Button>
      ) : null}
    </ChatWidgetShell>
  );
}

export const ConnectorSetupWidget = memo(ConnectorSetupWidgetImpl);
