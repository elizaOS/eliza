"use client";

import {
  BrandButton,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@elizaos/cloud-ui";
import { Check, ExternalLink, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { AGENT_FLAVORS, getDefaultFlavor, getFlavorById } from "@/lib/constants/agent-flavors";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { formatHourlyRate, formatUSD } from "@/lib/constants/agent-pricing-display";
import { openWebUIWithPairing } from "@/lib/hooks/open-web-ui";
import { type SandboxStatus, useSandboxStatusPoll } from "@/lib/hooks/use-sandbox-status-poll";

// ----------------------------------------------------------------
// Provisioning Steps
// ----------------------------------------------------------------

interface StepConfig {
  label: string;
  matchStatuses: SandboxStatus[];
}

const PROVISIONING_STEPS: StepConfig[] = [
  { label: "Agent created", matchStatuses: [] },
  { label: "Provisioning database", matchStatuses: ["pending"] },
  { label: "Starting container", matchStatuses: ["provisioning"] },
  { label: "Agent running", matchStatuses: ["running"] },
];

function getActiveStepIndex(status: SandboxStatus): number {
  if (status === "running") return 3;
  if (status === "provisioning") return 2;
  if (status === "pending") return 1;
  return 0;
}

type StepState = "complete" | "active" | "pending" | "error";

function getStepState(stepIndex: number, activeIndex: number, hasError: boolean): StepState {
  if (hasError && stepIndex === activeIndex) return "error";
  if (stepIndex < activeIndex) return "complete";
  if (stepIndex === activeIndex) return "active";
  return "pending";
}

// ----------------------------------------------------------------
// Step Indicator Component
// ----------------------------------------------------------------

function StepIndicator({ state }: { state: StepState }) {
  const base = "flex h-6 w-6 shrink-0 items-center justify-center";

  switch (state) {
    case "complete":
      return (
        <div className={`${base} bg-emerald-500/15 text-emerald-400 border border-emerald-500/30`}>
          <Check className="h-3 w-3" />
        </div>
      );
    case "active":
      return (
        <div className={`${base} bg-[#FF5800]/15 border border-[#FF5800]/30 relative`}>
          <Loader2 className="h-3 w-3 text-[#FF5800] animate-spin" />
        </div>
      );
    case "error":
      return (
        <div
          className={`${base} bg-red-500/15 text-red-400 border border-red-500/30 animate-[shake_0.3s_ease-in-out]`}
        >
          <X className="h-3 w-3" />
        </div>
      );
    case "pending":
    default:
      return (
        <div className={`${base} bg-white/[0.03] border border-white/10`}>
          <span className="h-1 w-1 bg-white/20" />
        </div>
      );
  }
}

// ----------------------------------------------------------------
// Provisioning Progress View
// ----------------------------------------------------------------

function ProvisioningProgress({
  status,
  error,
  agentId,
  elapsedSec,
  onClose,
  onRetry,
}: {
  status: SandboxStatus;
  error: string | null;
  agentId: string;
  elapsedSec: number;
  onClose: () => void;
  onRetry: () => void;
}) {
  const activeIndex = getActiveStepIndex(status);
  const hasError = status === "error";
  const isComplete = status === "running";

  return (
    <div className="space-y-5 py-1">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/70">
          {isComplete
            ? "Your agent is ready"
            : hasError
              ? "Something went wrong"
              : "Setting up your agent…"}
        </p>
        {!isComplete && !hasError && (
          <span className="text-[11px] tabular-nums text-white/30">
            {elapsedSec < 60
              ? `${elapsedSec}s`
              : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`}
            {" · ~90s"}
          </span>
        )}
      </div>

      {/* Steps */}
      <div className="relative space-y-0">
        {PROVISIONING_STEPS.map((step, i) => {
          const state = getStepState(i, activeIndex, hasError);
          const isLast = i === PROVISIONING_STEPS.length - 1;
          return (
            <div key={step.label} className="flex items-start gap-3 relative">
              {/* Vertical connector */}
              {!isLast && (
                <div
                  className="absolute left-[11px] top-6 w-px"
                  style={{ height: "calc(100% - 2px)" }}
                >
                  <div
                    className={`h-full w-full transition-colors duration-500 ${
                      state === "complete"
                        ? "bg-emerald-500/30"
                        : state === "error"
                          ? "bg-red-500/20"
                          : "bg-white/5"
                    }`}
                  />
                </div>
              )}
              <StepIndicator state={state} />
              <div className="pb-4 pt-0.5">
                <p
                  className={`text-sm transition-colors duration-300 ${
                    state === "complete"
                      ? "text-emerald-400/80"
                      : state === "active"
                        ? "text-white"
                        : state === "error"
                          ? "text-red-400"
                          : "text-white/25"
                  }`}
                >
                  {step.label}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Error detail */}
      {hasError && error && (
        <div className="border border-red-500/20 bg-red-500/5 px-3 py-2.5 space-y-2">
          <p className="text-sm text-red-400">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 text-xs text-red-300 hover:text-white transition-colors"
          >
            <RotateCcw className="h-3 w-3" />
            Retry provisioning
          </button>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex gap-2 pt-1">
        {isComplete ? (
          <>
            <BrandButton size="sm" onClick={() => openWebUIWithPairing(agentId)}>
              <ExternalLink className="h-3.5 w-3.5" />
              Open Web UI
            </BrandButton>
            <BrandButton variant="outline" size="sm" onClick={onClose}>
              Done
            </BrandButton>
          </>
        ) : (
          <BrandButton variant="outline" size="sm" onClick={onClose}>
            Close
          </BrandButton>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------
// Main Dialog Component
// ----------------------------------------------------------------

interface CreateElizaAgentDialogProps {
  trigger?: ReactNode;
  onProvisionQueued?: (agentId: string, jobId: string) => void;
  /** Called after a sandbox is successfully created so the parent can refresh. */
  onCreated?: () => void | Promise<void>;
}

type CreatePhase = "form" | "creating" | "provisioning";

export function CreateElizaAgentDialog({
  trigger,
  onProvisionQueued,
  onCreated,
}: CreateElizaAgentDialogProps) {
  const [open, setOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [flavorId, setFlavorId] = useState(getDefaultFlavor().id);
  const [customImage, setCustomImage] = useState("");
  const [autoStart, setAutoStart] = useState(true);
  const [phase, setPhase] = useState<CreatePhase>("form");
  const [error, setError] = useState<string | null>(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [provisionStartTime, setProvisionStartTime] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const busy = phase === "creating";
  const isProvisioningPhase = phase === "provisioning";
  const selectedFlavor = getFlavorById(flavorId);
  const isCustom = flavorId === "custom";
  const resolvedDockerImage = isCustom ? customImage.trim() : selectedFlavor?.dockerImage;

  // Poll the agent status while in provisioning phase
  const pollResult = useSandboxStatusPoll(isProvisioningPhase ? createdAgentId : null, {
    intervalMs: 5_000,
    enabled: isProvisioningPhase,
  });

  // Elapsed time counter
  useEffect(() => {
    if (!provisionStartTime) {
      setElapsedSec(0);
      return;
    }
    const tick = () => setElapsedSec(Math.floor((Date.now() - provisionStartTime) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [provisionStartTime]);

  // When provisioning completes, notify via toast (refresh happens in handleClose)
  useEffect(() => {
    if (isProvisioningPhase && pollResult.status === "running") {
      toast.success("Agent is up and running!");
    }
  }, [isProvisioningPhase, pollResult.status]);

  function resetForm() {
    setAgentName("");
    setFlavorId(getDefaultFlavor().id);
    setCustomImage("");
    setError(null);
    setPhase("form");
    setCreatedAgentId(null);
    setProvisionStartTime(null);
    setElapsedSec(0);
  }

  function handleClose() {
    setOpen(false);
    // Delay reset so the closing animation finishes
    setTimeout(resetForm, 300);
    // Only notify parent when an agent was actually created (skip premature dismissals)
    if (createdAgentId) {
      onCreated?.()?.catch(() => {
        // Best-effort refresh — parent will retry on next poll cycle
      });
    }
  }

  async function handleCreate() {
    const trimmedName = agentName.trim();
    if (!trimmedName || busy) return;

    setError(null);
    setPhase("creating");

    try {
      const createBody: Record<string, string | undefined> = {
        agentName: trimmedName,
      };
      if (resolvedDockerImage && flavorId !== getDefaultFlavor().id) {
        createBody.dockerImage = resolvedDockerImage;
      }

      const createRes = await fetch("/api/v1/eliza/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      });

      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        throw new Error(
          (createData as { error?: string }).error ?? `Create failed (${createRes.status})`,
        );
      }

      const agentId = (createData as { data?: { id?: string } }).data?.id;
      if (!agentId) {
        throw new Error("Agent created but no agent id was returned");
      }

      setCreatedAgentId(agentId);

      if (autoStart) {
        // Transition to provisioning view instead of closing
        setPhase("provisioning");
        setProvisionStartTime(Date.now());

        const provisionRes = await fetch(`/api/v1/eliza/agents/${agentId}/provision`, {
          method: "POST",
        });
        const provisionData = await provisionRes.json().catch(() => ({}));

        if (provisionRes.status === 202 || provisionRes.status === 409) {
          const jobId = (provisionData as { data?: { jobId?: string } }).data?.jobId;
          if (jobId) {
            onProvisionQueued?.(agentId, jobId);
          }
          // Stay in provisioning view — the polling hook will track status
        } else if (provisionRes.ok) {
          // Already running (synchronous provision)
          toast.success("Agent is running");
          handleClose();
        } else {
          toast.warning(
            (provisionData as { error?: string }).error ??
              "Agent created, but auto-start failed. You can start it from the table.",
          );
          handleClose();
        }
      } else {
        toast.success(`Agent "${trimmedName}" created`);
        handleClose();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setPhase("form");
      toast.error(message);
    }
  }

  async function handleRetryProvision() {
    if (!createdAgentId) return;
    setProvisionStartTime(Date.now());

    try {
      const res = await fetch(`/api/v1/eliza/agents/${createdAgentId}/provision`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 202 || res.status === 409) {
        const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
        if (jobId) {
          onProvisionQueued?.(createdAgentId, jobId);
        }
        toast.info("Retrying provisioning…");
      } else if (!res.ok) {
        toast.error((data as { error?: string }).error ?? "Retry failed");
      }
    } catch (err) {
      toast.error(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <>
      {trigger ? (
        <div onClick={() => phase === "form" && setOpen(true)}>{trigger}</div>
      ) : (
        <BrandButton size="sm" onClick={() => setOpen(true)} disabled={busy}>
          <Plus className="h-4 w-4" />
          New Agent
        </BrandButton>
      )}

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) {
            handleClose();
          }
        }}
      >
        <DialogContent className="sm:max-w-md bg-neutral-900 border-white/10">
          <DialogHeader>
            <DialogTitle className="text-white">
              {isProvisioningPhase ? "Launching Agent" : "New Agent"}
            </DialogTitle>
          </DialogHeader>

          {isProvisioningPhase ? (
            <ProvisioningProgress
              status={pollResult.status}
              error={pollResult.error}
              agentId={createdAgentId!}
              elapsedSec={elapsedSec}
              onClose={handleClose}
              onRetry={handleRetryProvision}
            />
          ) : (
            <>
              <div className="space-y-4 py-2">
                {/* Agent name */}
                <div className="space-y-1.5">
                  <Label htmlFor="eliza-agent-name" className="text-white/60 text-xs">
                    Agent Name
                  </Label>
                  <Input
                    id="eliza-agent-name"
                    placeholder="e.g. eliza-alpha"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    disabled={busy}
                    className="bg-black/40 border-white/10 text-white placeholder:text-white/25 focus-visible:ring-[#FF5800]/50"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleCreate();
                      }
                    }}
                    maxLength={100}
                    autoFocus
                  />
                </div>

                {/* Flavor selector */}
                <div className="space-y-1.5">
                  <Label htmlFor="eliza-flavor" className="text-white/60 text-xs">
                    Type
                  </Label>
                  <Select value={flavorId} onValueChange={setFlavorId} disabled={busy}>
                    <SelectTrigger
                      id="eliza-flavor"
                      className="bg-black/40 border-white/10 text-white"
                    >
                      <SelectValue placeholder="Select flavor" />
                    </SelectTrigger>
                    <SelectContent className="border-white/10 bg-neutral-900">
                      {AGENT_FLAVORS.map((flavor) => (
                        <SelectItem key={flavor.id} value={flavor.id}>
                          <div className="flex flex-col">
                            <span>{flavor.name}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedFlavor && (
                    <p className="text-[11px] text-white/35">{selectedFlavor.description}</p>
                  )}
                </div>

                {/* Custom image input */}
                {isCustom && (
                  <div className="space-y-1.5">
                    <Label htmlFor="eliza-custom-image" className="text-white/60 text-xs">
                      Docker Image
                    </Label>
                    <Input
                      id="eliza-custom-image"
                      placeholder="e.g. myregistry/agent:latest"
                      value={customImage}
                      onChange={(e) => setCustomImage(e.target.value)}
                      disabled={busy}
                      className="bg-black/40 border-white/10 text-white placeholder:text-white/25"
                      maxLength={256}
                    />
                  </div>
                )}

                {/* Auto-start toggle */}
                <div className="flex items-center justify-between gap-4 border border-white/10 bg-black/20 px-3 py-2.5">
                  <div className="space-y-0.5">
                    <Label htmlFor="eliza-auto-start" className="text-sm text-white/70">
                      Start immediately
                    </Label>
                    <p className="text-[11px] text-white/35">Start right after creation</p>
                  </div>
                  <Switch
                    id="eliza-auto-start"
                    checked={autoStart}
                    onCheckedChange={setAutoStart}
                    disabled={busy}
                  />
                </div>

                {/* Cost notice */}
                {autoStart && (
                  <div className="flex items-start gap-2.5 border border-[#FF5800]/15 bg-[#FF5800]/5 px-3 py-2.5">
                    <div className="shrink-0 mt-0.5 w-1.5 h-1.5 bg-[#FF5800] rounded-full" />
                    <div className="space-y-0.5">
                      <p className="text-[11px] font-mono text-white/70">
                        {formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE)}
                        /hr running · {formatHourlyRate(AGENT_PRICING.IDLE_HOURLY_RATE)}/hr idle
                      </p>
                      <p className="text-[10px] font-mono text-white/35">
                        Min. deposit {formatUSD(AGENT_PRICING.MINIMUM_DEPOSIT)}
                      </p>
                    </div>
                  </div>
                )}

                {/* Inline error */}
                {error && (
                  <div className="border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
                    {error}
                  </div>
                )}
              </div>

              <DialogFooter>
                <BrandButton variant="outline" onClick={handleClose} disabled={busy}>
                  Cancel
                </BrandButton>
                <BrandButton
                  onClick={() => void handleCreate()}
                  disabled={!agentName.trim() || busy || (isCustom && !customImage.trim())}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy ? "Creating…" : autoStart ? "Deploy" : "Create"}
                </BrandButton>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
