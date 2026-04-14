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
      {meta ? (
        <div className="mt-1 text-xs-tight text-muted">{meta}</div>
      ) : null}
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
  const purposeValue = tags?.length ? tags.join(", ") : "Inference";

  return (
    <PagePanel variant="section" className="p-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
              {callLabel}
            </div>
            <div className="text-lg font-semibold text-txt">{model}</div>
            {tags?.length ? (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-border/50 bg-bg/60 px-2.5 py-1 text-[11px] font-medium text-muted"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {systemPrompt ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowSystem((current) => !current)}
              className="shrink-0 gap-2 self-start"
            >
              {showSystem ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              {showSystem ? systemCollapseLabel : systemPromptButtonLabel}
            </Button>
          ) : null}
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <CallMetric
            label={purposeLabel}
            value={purposeValue}
            meta={callLabel}
          />
          <CallMetric
            label={latencyLabel}
            value={response.length}
            meta={outputLinesLabel}
          />
          <CallMetric
            label={costLabel}
            value={costValue}
            meta={temperatureLabel}
          />
          <CallMetric
            label={tokensLabel}
            value={totalTokensValue}
            meta={tokenBreakdownMeta}
          />
          <CallMetric
            label={maxLabel}
            value={maxValue}
            meta={inputLinesLabel}
          />
          <CallMetric
            label={temperatureLabel}
            value={temperatureValue}
            meta={systemPrompt ? systemLinesLabel : systemExpandLabel}
          />
        </div>

        {systemPrompt && showSystem ? (
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
        ) : null}
      </div>

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
