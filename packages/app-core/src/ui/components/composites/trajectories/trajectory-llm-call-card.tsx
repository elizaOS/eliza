import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";

import { Button } from "../../ui/button";
import { PagePanel } from "../page-panel";
import { TrajectoryCodeBlock } from "./trajectory-code-block";

interface CallMetricProps {
  label: React.ReactNode;
  value: React.ReactNode;
  meta?: React.ReactNode;
}

function CallMetric({ label, value, meta }: CallMetricProps) {
  return (
    <PagePanel.SummaryCard compact className="px-4 py-3">
      <div className="text-xs-tight uppercase tracking-[0.14em] text-muted/70">
        {label}
      </div>
      <div className="mt-2 text-sm font-semibold text-txt">{value}</div>
      {meta ? <div className="mt-1 text-xs-tight text-muted">{meta}</div> : null}
    </PagePanel.SummaryCard>
  );
}

export interface TrajectoryLlmCallCardProps {
  callLabel: React.ReactNode;
  copyLabel: React.ReactNode;
  copyToClipboardLabel?: string;
  costLabel: React.ReactNode;
  costValue: React.ReactNode;
  inputLabel: React.ReactNode;
  latencyLabel: React.ReactNode;
  maxLabel: React.ReactNode;
  maxValue: React.ReactNode;
  model: React.ReactNode;
  onCopy: (content: string) => void;
  outputLabel: React.ReactNode;
  purposeLabel: React.ReactNode;
  response: string;
  systemCollapseLabel: React.ReactNode;
  systemExpandLabel: React.ReactNode;
  systemLabel: React.ReactNode;
  systemLinesLabel: React.ReactNode;
  systemPrompt?: string | null;
  systemPromptButtonLabel: React.ReactNode;
  temperatureLabel: React.ReactNode;
  temperatureValue: React.ReactNode;
  tokensLabel: React.ReactNode;
  totalTokensValue: React.ReactNode;
  tokenBreakdownMeta: React.ReactNode;
  tags?: readonly string[];
  inputLinesLabel: React.ReactNode;
  outputLinesLabel: React.ReactNode;
  userPrompt: string;
}

export function TrajectoryLlmCallCard({
  callLabel,
  copyLabel,
  copyToClipboardLabel,
  costLabel,
  costValue,
  inputLabel,
  latencyLabel,
  maxLabel,
  maxValue,
  model,
  onCopy,
  outputLabel,
  purposeLabel,
  response,
  systemCollapseLabel,
  systemExpandLabel,
  systemLabel,
  systemLinesLabel,
  systemPrompt,
  systemPromptButtonLabel,
  temperatureLabel,
  temperatureValue,
  tokensLabel,
  totalTokensValue,
  tokenBreakdownMeta,
  tags,
  inputLinesLabel,
  outputLinesLabel,
  userPrompt,
}: TrajectoryLlmCallCardProps) {
  const [showSystem, setShowSystem] = React.useState(false);

  return (
    <PagePanel variant="section" className="p-5">
      {systemPrompt ? (
            <div className="mt-3">
            <TrajectoryCodeBlock
              content={systemPrompt}
              label={systemLabel}
              linesLabel={systemLinesLabel}
              copyLabel={copyLabel}
              copyToClipboardLabel={copyToClipboardLabel}
              collapseLabel={systemCollapseLabel}
              expandLabel={systemExpandLabel}
              onCopy={onCopy}
            />
          </div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <TrajectoryCodeBlock
          content={userPrompt}
          label={inputLabel}
          linesLabel={inputLinesLabel}
          copyLabel={copyLabel}
          copyToClipboardLabel={copyToClipboardLabel}
          collapseLabel={systemCollapseLabel}
          expandLabel={systemExpandLabel}
          onCopy={onCopy}
        />
        <TrajectoryCodeBlock
          content={response}
          label={outputLabel}
          linesLabel={outputLinesLabel}
          copyLabel={copyLabel}
          copyToClipboardLabel={copyToClipboardLabel}
          collapseLabel={systemCollapseLabel}
          expandLabel={systemExpandLabel}
          onCopy={onCopy}
        />
      </div>
    </PagePanel>
  );
}
