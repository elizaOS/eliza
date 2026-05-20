'use client';

import {
  calculateModelPilotEstimateRange,
  cn,
  MODEL_PILOT_DELIVERABLES,
  MODEL_PILOT_OUTPUTS,
  MODEL_PILOT_REVIEW_LEVELS,
  MODEL_PILOT_SCENARIOS,
  type ModelPilotDeliverable,
  type ModelPilotOutput,
  type ModelPilotReviewLevel,
  type ModelPilotScenario,
  modelPilotDeliverableAffectsEstimate,
} from '@babylon/shared';
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { PageContainer } from '@/components/shared/PageContainer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

const TERMS_URL = 'https://docs.babylon.market/legal/terms-of-service/';

const fieldClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

const rangeClass =
  'h-1.5 w-full cursor-pointer appearance-none rounded-md bg-muted accent-primary';

type PricingScopeMode = 'none' | 'full' | 'fineTuneOnly';

function PricingScopeBadge({ mode }: { mode: PricingScopeMode }) {
  if (mode === 'fineTuneOnly') {
    return (
      <span
        className="inline-flex max-w-full shrink-0 items-center rounded border border-primary/45 bg-primary/10 px-2 py-0.5 font-medium text-primary text-xs leading-tight"
        title="Other deliverables still shape your quote; only fine-tuning options change the calculator."
      >
        Fine-tuning adjusts estimate
      </span>
    );
  }
  if (mode === 'full') {
    return (
      <span className="inline-flex max-w-full shrink-0 items-center rounded border border-primary/50 bg-primary/10 px-2 py-0.5 font-medium text-primary text-xs leading-tight">
        Affects this estimate
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full shrink-0 items-center rounded border border-border bg-muted/60 px-2 py-0.5 font-medium text-muted-foreground text-xs leading-tight">
      Does not change this estimate
    </span>
  );
}

const estimateDockClass =
  'fixed inset-x-0 bottom-0 z-[120] border-primary/35 border-t-2 bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-12px_40px_rgba(0,0,0,0.1)] backdrop-blur-md lg:py-3';

/**
 * Renders the live estimate strip on document.body so position:fixed is always
 * tied to the viewport (nested stacking/transform contexts can otherwise hide it).
 */
function ModelPilotEstimateDock({ estimate }: { estimate: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return createPortal(
    <div
      className={estimateDockClass}
      role="region"
      aria-label="Live price estimate"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 lg:justify-start">
          <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 font-semibold text-[10px] text-primary uppercase tracking-wider">
            Live
          </span>
          <div className="flex min-w-0 flex-1 items-baseline justify-end gap-3 sm:justify-start lg:flex-initial">
            <span className="shrink-0 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
              Est. range
            </span>
            <span className="min-w-0 font-bold text-foreground text-lg tabular-nums tracking-tight lg:text-2xl">
              {estimate}
            </span>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug lg:max-w-md lg:flex-1 lg:text-right lg:text-xs">
          Updates from fine-tuning selections, scale, full labeling support, and
          deployment options — not model connection, scenarios, or output
          formats.
        </p>
      </div>
    </div>,
    document.body
  );
}

export function ModelPilotInquiryForm() {
  const [modelProvider, setModelProvider] = useState('');
  const [modelName, setModelName] = useState('');
  const [apiEndpoint, setApiEndpoint] = useState('');
  const [toolUse, setToolUse] = useState(false);
  const [memory, setMemory] = useState(false);

  const [selectedDeliverables, setSelectedDeliverables] = useState<
    ModelPilotDeliverable[]
  >(['Behavioral data', 'Evaluation report']);
  const [selectedScenarios, setSelectedScenarios] = useState<
    ModelPilotScenario[]
  >(['Market manipulation', 'Scam detection']);
  const [selectedOutputs, setSelectedOutputs] = useState<ModelPilotOutput[]>([
    'Structured data',
    'Evaluation report',
  ]);

  const [concurrentAgents, setConcurrentAgents] = useState(500);
  const [scenarioRuns, setScenarioRuns] = useState(10_000);
  const [humanReview, setHumanReview] =
    useState<ModelPilotReviewLevel>('Light review');
  const [privateDeployment, setPrivateDeployment] = useState(false);
  const [dataExclusivity, setDataExclusivity] = useState(false);

  const [email, setEmail] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const toggle = <T extends string>(
    item: T,
    setList: Dispatch<SetStateAction<T[]>>,
    options?: { minSelected?: number }
  ) => {
    const min = options?.minSelected ?? 0;
    setList((prev) => {
      if (prev.includes(item)) {
        const next = prev.filter((i) => i !== item);
        if (min > 0 && next.length < min) {
          return prev;
        }
        return next;
      }
      return [...prev, item];
    });
  };

  const estimate = calculateModelPilotEstimateRange({
    deliverables: selectedDeliverables,
    review: humanReview,
    privateDeployment,
    dataExclusivity,
    concurrentAgents,
    scenarioRuns,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !agreedToTerms || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/model-pilot-inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          agreedToTerms: true as const,
          modelProvider,
          modelName,
          apiEndpoint,
          toolUse,
          memory,
          deliverables: selectedDeliverables,
          scenarios: selectedScenarios,
          outputs: selectedOutputs,
          concurrentAgents,
          scenarioRuns,
          humanReview,
          privateDeployment,
          dataExclusivity,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };

      if (!res.ok) {
        if (res.status === 429) {
          toast.error('Too many requests. Please try again shortly.');
        } else if (res.status === 400) {
          toast.error(
            'Something in the form could not be sent. Check required selections and try again.'
          );
        } else if (data.reason === 'provider_not_configured') {
          toast.error(
            'Email delivery is not configured. Please try again later.'
          );
        } else {
          toast.error('Could not send your request. Please try again.');
        }
        return;
      }

      toast.success('Request received. Check your email for a copy.');
      setAgreedToTerms(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      {/* overflow-x-visible so position:sticky on the estimate column works (overflow-x-hidden on an ancestor breaks sticky in common browsers) */}
      <PageContainer className="overflow-x-visible py-8 md:py-10">
        <div className="mx-auto w-full max-w-6xl">
          <header className="mb-10 max-w-3xl">
            <p className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
              Model pilot inquiry
            </p>
            <h1 className="font-bold text-2xl text-foreground tracking-tight md:text-3xl">
              Bring Your Model to Babylon
            </h1>
            <p className="mt-3 max-w-prose text-base text-muted-foreground leading-relaxed md:text-lg">
              Connect your model, run adversarial social and market scenarios,
              and receive behavioral data, evaluations, or a fine-tuned version
              of your model. Use the{' '}
              <span className="font-medium text-foreground">Live</span> strip at
              the bottom to watch the estimate while you scroll.
            </p>
          </header>

          <form onSubmit={handleSubmit} className="relative pb-28 lg:pb-24">
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
              <div className="space-y-0 lg:col-span-2">
                <section
                  className="scroll-mt-6 border-border border-b py-10"
                  aria-labelledby="model-pilot-step-1"
                >
                  <div className="mb-8">
                    <div className="flex flex-wrap items-center gap-2 gap-y-2">
                      <h2
                        id="model-pilot-step-1"
                        className="font-semibold text-foreground text-lg tracking-tight"
                      >
                        1. Connect Your Model
                      </h2>
                      <PricingScopeBadge mode="none" />
                    </div>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Plug your model into Babylon&apos;s training environment.
                      Used to plan integration; the range on the right is not
                      tied to provider, endpoint, tool use, or memory.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <div>
                      <Label
                        className="mb-1.5 block text-foreground text-sm"
                        htmlFor="model-pilot-provider"
                      >
                        Model Provider
                      </Label>
                      <Input
                        id="model-pilot-provider"
                        className={fieldClass}
                        placeholder="e.g., OpenAI, Anthropic, Custom"
                        value={modelProvider}
                        onChange={(ev) => setModelProvider(ev.target.value)}
                        autoComplete="organization"
                      />
                    </div>
                    <div>
                      <Label
                        className="mb-1.5 block text-foreground text-sm"
                        htmlFor="model-pilot-name"
                      >
                        Model Name
                      </Label>
                      <Input
                        id="model-pilot-name"
                        className={fieldClass}
                        placeholder="e.g., gpt-4-turbo, claude-3-opus"
                        value={modelName}
                        onChange={(ev) => setModelName(ev.target.value)}
                        autoComplete="off"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <Label
                        className="mb-1.5 block text-foreground text-sm"
                        htmlFor="model-pilot-endpoint"
                      >
                        API Endpoint
                      </Label>
                      <Input
                        id="model-pilot-endpoint"
                        className={cn(fieldClass, 'font-mono text-xs')}
                        placeholder="https://api.your-provider.com/v1/chat/completions"
                        value={apiEndpoint}
                        onChange={(ev) => setApiEndpoint(ev.target.value)}
                        autoComplete="url"
                        inputMode="url"
                      />
                    </div>
                    <div className="flex flex-wrap gap-6 pt-2 md:col-span-2">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={toolUse}
                          onChange={(ev) => setToolUse(ev.target.checked)}
                          className="size-4 rounded border border-border text-primary focus:ring-ring"
                        />
                        <span className="font-medium text-foreground text-sm">
                          Tool use enabled
                        </span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={memory}
                          onChange={(ev) => setMemory(ev.target.checked)}
                          className="size-4 rounded border border-border text-primary focus:ring-ring"
                        />
                        <span className="font-medium text-foreground text-sm">
                          Memory enabled
                        </span>
                      </label>
                    </div>
                  </div>
                </section>

                <section
                  className="scroll-mt-6 border-border border-b py-10"
                  aria-labelledby="model-pilot-step-2"
                >
                  <div className="mb-8">
                    <div className="flex flex-wrap items-center gap-2 gap-y-2">
                      <h2
                        id="model-pilot-step-2"
                        className="font-semibold text-foreground text-lg tracking-tight"
                      >
                        2. What should Babylon deliver?
                      </h2>
                      <PricingScopeBadge mode="fineTuneOnly" />
                    </div>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Pick everything you want; the calculator only moves when
                      you include a{' '}
                      <span className="font-medium text-foreground">
                        fine-tuned
                      </span>{' '}
                      deliverable. Everything here still drives the proposal we
                      send you.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {MODEL_PILOT_DELIVERABLES.map((item) => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={selectedDeliverables.includes(item)}
                        onClick={() =>
                          toggle(item, setSelectedDeliverables, {
                            minSelected: 1,
                          })
                        }
                        className={cn(
                          'rounded-md border px-4 py-3 text-left font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                          selectedDeliverables.includes(item)
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-muted-foreground hover:bg-muted/60'
                        )}
                      >
                        <span className="block">{item}</span>
                        {modelPilotDeliverableAffectsEstimate(item) ? (
                          <span
                            className={cn(
                              'mt-1 block font-normal text-[10px] uppercase tracking-wide',
                              selectedDeliverables.includes(item)
                                ? 'text-primary-foreground/80'
                                : 'text-primary'
                            )}
                          >
                            Affects estimate
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </section>

                <section
                  className="scroll-mt-6 border-border border-b py-10"
                  aria-labelledby="model-pilot-step-3"
                >
                  <div className="mb-8">
                    <div className="flex flex-wrap items-center gap-2 gap-y-2">
                      <h2
                        id="model-pilot-step-3"
                        className="font-semibold text-foreground text-lg tracking-tight"
                      >
                        3. Choose Training Scenarios
                      </h2>
                      <PricingScopeBadge mode="none" />
                    </div>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Select the environments and behaviors you want to test and
                      capture. This shapes the engagement; it does not move the
                      ballpark figure shown here (volume in step 4 does).
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {MODEL_PILOT_SCENARIOS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={selectedScenarios.includes(item)}
                        onClick={() =>
                          toggle(item, setSelectedScenarios, { minSelected: 1 })
                        }
                        className={cn(
                          'rounded-md border px-4 py-2 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                          selectedScenarios.includes(item)
                            ? 'border-border bg-muted text-foreground'
                            : 'border-border bg-background text-muted-foreground hover:bg-muted/50'
                        )}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </section>

                <section
                  className="scroll-mt-6 border-border border-b py-10"
                  aria-labelledby="model-pilot-step-4"
                >
                  <div className="mb-8">
                    <div className="flex flex-wrap items-center gap-2 gap-y-2">
                      <h2
                        id="model-pilot-step-4"
                        className="font-semibold text-foreground text-lg tracking-tight"
                      >
                        4. Configure the Run
                      </h2>
                      <PricingScopeBadge mode="full" />
                    </div>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Concurrent agents and scenario runs scale the range. Human
                      review adds cost only for{' '}
                      <span className="font-medium text-foreground">
                        Full labeling support
                      </span>
                      . Private deployment and data exclusivity each add a
                      surcharge in this model.
                    </p>
                  </div>
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
                      <div>
                        <div className="mb-2 flex justify-between">
                          <span className="font-medium text-foreground text-sm">
                            Concurrent Agents
                          </span>
                          <span className="font-mono text-foreground text-sm">
                            {concurrentAgents.toLocaleString()}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={10}
                          max={5000}
                          step={10}
                          value={concurrentAgents}
                          onChange={(ev) =>
                            setConcurrentAgents(Number(ev.target.value))
                          }
                          className={rangeClass}
                          aria-label="Concurrent agents"
                          aria-valuemin={10}
                          aria-valuemax={5000}
                          aria-valuenow={concurrentAgents}
                        />
                      </div>
                      <div>
                        <div className="mb-2 flex justify-between">
                          <span className="font-medium text-foreground text-sm">
                            Scenario Runs
                          </span>
                          <span className="font-mono text-foreground text-sm">
                            {scenarioRuns.toLocaleString()}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={100}
                          max={100_000}
                          step={100}
                          value={scenarioRuns}
                          onChange={(ev) =>
                            setScenarioRuns(Number(ev.target.value))
                          }
                          className={rangeClass}
                          aria-label="Scenario runs"
                          aria-valuemin={100}
                          aria-valuemax={100_000}
                          aria-valuenow={scenarioRuns}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-3">
                      <div>
                        <Label
                          className="mb-2 block text-foreground text-sm"
                          htmlFor="model-pilot-human-review"
                        >
                          Human review
                        </Label>
                        <Select
                          id="model-pilot-human-review"
                          className={fieldClass}
                          value={humanReview}
                          onValueChange={(v) =>
                            setHumanReview(v as ModelPilotReviewLevel)
                          }
                        >
                          {MODEL_PILOT_REVIEW_LEVELS.map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="flex flex-col justify-center gap-4 sm:col-span-2 sm:pl-4">
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={privateDeployment}
                            onCheckedChange={setPrivateDeployment}
                            id="private-deployment"
                          />
                          <label
                            htmlFor="private-deployment"
                            className="cursor-pointer"
                          >
                            <span className="block font-medium text-foreground text-sm">
                              Private Deployment
                            </span>
                            <span className="block text-muted-foreground text-xs">
                              Run in an isolated environment
                            </span>
                          </label>
                        </div>
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={dataExclusivity}
                            onCheckedChange={setDataExclusivity}
                            id="data-exclusivity"
                          />
                          <label
                            htmlFor="data-exclusivity"
                            className="cursor-pointer"
                          >
                            <span className="block font-medium text-foreground text-sm">
                              Data Exclusivity
                            </span>
                            <span className="block text-muted-foreground text-xs">
                              Retain full rights to generated data
                            </span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Live range in the main column after pricing controls (sticky sidebar header may be off-screen). */}
                <div
                  className="hidden items-center justify-between gap-4 border-border border-t py-6 lg:flex"
                  aria-live="polite"
                  aria-label="Current estimate"
                >
                  <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 font-semibold text-[10px] text-primary uppercase tracking-wider">
                    Live
                  </span>
                  <div className="flex flex-1 items-baseline justify-end gap-3">
                    <span className="shrink-0 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                      Est. range
                    </span>
                    <span className="font-bold text-foreground text-xl tabular-nums tracking-tight">
                      {estimate}
                    </span>
                  </div>
                </div>

                <section
                  className="scroll-mt-6 py-10"
                  aria-labelledby="model-pilot-step-5"
                >
                  <div className="mb-8">
                    <div className="flex flex-wrap items-center gap-2 gap-y-2">
                      <h2
                        id="model-pilot-step-5"
                        className="font-semibold text-foreground text-lg tracking-tight"
                      >
                        5. Outputs
                      </h2>
                      <PricingScopeBadge mode="none" />
                    </div>
                    <p className="mt-1 text-muted-foreground text-sm">
                      Choose what Babylon returns at the end of the run. The
                      estimate does not change with these selections; they align
                      the statement of work with deliverables above.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {MODEL_PILOT_OUTPUTS.map((item) => (
                      <button
                        key={item}
                        type="button"
                        aria-pressed={selectedOutputs.includes(item)}
                        onClick={() => toggle(item, setSelectedOutputs)}
                        className={cn(
                          'rounded-md border px-4 py-2 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                          selectedOutputs.includes(item)
                            ? 'border-border bg-muted text-foreground'
                            : 'border-border bg-background text-muted-foreground hover:bg-muted/50'
                        )}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </section>
              </div>

              <div className="lg:col-span-1">
                <div className="lg:sticky lg:top-4 lg:z-30 lg:border-border lg:border-l lg:py-10 lg:pl-10">
                  <h3 className="mb-1 font-semibold text-foreground text-lg tracking-tight">
                    Pilot summary
                  </h3>
                  <p className="mb-6 text-muted-foreground text-sm">
                    Estimate, scope recap, and where to send your request.
                  </p>

                  <div className="mb-8 border-border border-b pb-6">
                    <span className="mb-1 block font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                      Estimated range
                    </span>
                    <div className="font-bold text-2xl text-foreground tracking-tight md:text-3xl">
                      {estimate}
                    </div>
                    <p className="mt-3 text-muted-foreground text-xs leading-relaxed">
                      Indicative only; final pricing depends on review.
                    </p>
                    <div className="mt-4 space-y-3 rounded-md border border-border bg-muted/30 p-3 text-muted-foreground text-xs leading-relaxed">
                      <div>
                        <span className="font-semibold text-foreground">
                          Moves this range
                        </span>
                        <ul className="mt-1.5 list-disc space-y-1 pl-4">
                          <li>
                            Deliverables that include fine-tuning (see step 2)
                          </li>
                          <li>
                            Human review set to Full labeling support (step 4)
                          </li>
                          <li>
                            Private deployment or data exclusivity (step 4)
                          </li>
                          <li>
                            Concurrent agents and total scenario runs (step 4)
                          </li>
                        </ul>
                      </div>
                      <div>
                        <span className="font-semibold text-foreground">
                          Does not change this calculator
                        </span>
                        <ul className="mt-1.5 list-disc space-y-1 pl-4">
                          <li>
                            Model provider, name, endpoint, tool use, memory
                            (step 1)
                          </li>
                          <li>Which scenario topics you pick (step 3)</li>
                          <li>Output format checkboxes (step 5)</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div className="mb-8 space-y-5">
                    <div>
                      <span className="mb-1 block font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                        Model
                      </span>
                      <div className="font-medium text-foreground text-sm">
                        {modelName.trim() || 'Customer-provided model'}
                      </div>
                    </div>
                    <div>
                      <span className="mb-1 block font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                        Scope
                      </span>
                      <ul className="space-y-1 font-medium text-foreground text-sm">
                        <li>• {selectedScenarios.length} scenario packs</li>
                        <li>• {scenarioRuns.toLocaleString()} runs</li>
                        <li>
                          • {concurrentAgents.toLocaleString()} concurrent
                          agents
                        </li>
                      </ul>
                    </div>
                    <div>
                      <span className="mb-1 block font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                        Outputs
                      </span>
                      <ul className="space-y-1 font-medium text-foreground text-sm">
                        {selectedOutputs.length > 0 ? (
                          selectedOutputs.map((o) => <li key={o}>• {o}</li>)
                        ) : (
                          <li className="font-normal text-muted-foreground">
                            None selected
                          </li>
                        )}
                      </ul>
                    </div>
                    <div>
                      <span className="mb-1 block font-semibold text-muted-foreground text-xs uppercase tracking-wider">
                        Services
                      </span>
                      <ul className="space-y-1 font-medium text-foreground text-sm">
                        <li>• Scenario setup</li>
                        <li>• Data processing</li>
                        {humanReview !== 'Off' && <li>• {humanReview}</li>}
                        {selectedDeliverables.some(
                          modelPilotDeliverableAffectsEstimate
                        ) && <li>• Fine-tuning service</li>}
                        {privateDeployment && <li>• Private deployment</li>}
                        {dataExclusivity && <li>• Data exclusivity</li>}
                      </ul>
                    </div>
                  </div>

                  <div className="mb-6 space-y-4">
                    <div>
                      <Label
                        className="mb-1.5 block font-semibold text-foreground text-xs"
                        htmlFor="model-pilot-email"
                      >
                        Email address
                      </Label>
                      <Input
                        id="model-pilot-email"
                        className={fieldClass}
                        type="email"
                        autoComplete="email"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(ev) => setEmail(ev.target.value)}
                        required
                      />
                    </div>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={agreedToTerms}
                        onChange={(ev) => setAgreedToTerms(ev.target.checked)}
                        className="mt-0.5 size-4 rounded border border-border text-primary focus:ring-ring"
                      />
                      <span className="text-muted-foreground text-xs leading-relaxed">
                        I agree to the{' '}
                        <a
                          href={TERMS_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-primary underline"
                        >
                          Terms of Service
                        </a>{' '}
                        and consent to being contacted.
                      </span>
                    </label>
                  </div>

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={!email.trim() || !agreedToTerms || isSubmitting}
                  >
                    {isSubmitting ? 'Sending…' : 'Request pilot'}
                  </Button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </PageContainer>
      <ModelPilotEstimateDock estimate={estimate} />
    </>
  );
}
