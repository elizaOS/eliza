"use client";

/**
 * Dialog to create a cloud Eliza agent: pick a flavor for the environment and
 * provision it.
 */
import type { AgentFlavor } from "@elizaos/cloud-shared/lib/constants/agent-flavors";
import {
  getAgentFlavorsForEnv,
  getDefaultFlavor,
  getFlavorById,
} from "@elizaos/cloud-shared/lib/constants/agent-flavors";
import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
import {
  formatHourlyRate,
  formatUSD,
} from "@elizaos/cloud-shared/lib/constants/agent-pricing-display";
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
} from "@elizaos/ui/cloud-ui";
import {
  Check,
  Cloud,
  ExternalLink,
  Loader2,
  Plus,
  RotateCcw,
  Server,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button";
import { useT } from "../lib/i18n";
import { openWebUIWithPairing } from "../lib/open-web-ui";
import {
  type SandboxStatus,
  useSandboxStatusPoll,
} from "../lib/use-sandbox-status-poll";

interface StepConfig {
  labelKey: string;
  defaultLabel: string;
  matchStatuses: SandboxStatus[];
}

const PROVISIONING_STEPS: StepConfig[] = [
  {
    labelKey: "cloud.createAgent.stepCreated",
    defaultLabel: "Agent created",
    matchStatuses: [],
  },
  {
    labelKey: "cloud.createAgent.stepProvisioningDb",
    defaultLabel: "Provisioning database",
    matchStatuses: ["pending"],
  },
  {
    labelKey: "cloud.createAgent.stepStartingContainer",
    defaultLabel: "Starting container",
    matchStatuses: ["provisioning"],
  },
  {
    labelKey: "cloud.createAgent.stepRunning",
    defaultLabel: "Agent running",
    matchStatuses: ["running"],
  },
];

function getActiveStepIndex(status: SandboxStatus): number {
  if (status === "running") return 3;
  if (status === "provisioning") return 2;
  if (status === "pending") return 1;
  return 0;
}

type StepState = "complete" | "active" | "pending" | "error";

function getStepState(
  stepIndex: number,
  activeIndex: number,
  hasError: boolean,
): StepState {
  if (hasError && stepIndex === activeIndex) return "error";
  if (stepIndex < activeIndex) return "complete";
  if (stepIndex === activeIndex) return "active";
  return "pending";
}

function StepIndicator({ state }: { state: StepState }) {
  const base = "flex h-6 w-6 shrink-0 items-center justify-center";

  switch (state) {
    case "complete":
      return (
        <div
          className={`${base} bg-green-500/15 text-green-400 border border-green-500/30`}
        >
          <Check className="h-3 w-3" />
        </div>
      );
    case "active":
      return (
        <div
          className={`${base} bg-[#FF5800]/15 border border-[#FF5800]/30 relative`}
        >
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
    default:
      return (
        <div className={`${base} bg-white/[0.03] border border-white/10`}>
          <span className="h-1 w-1 bg-white/20" />
        </div>
      );
  }
}

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
  const t = useT();
  const activeIndex = getActiveStepIndex(status);
  const hasError = status === "error";
  const isComplete = status === "running";

  return (
    <div className="space-y-5 py-1">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/70">
          {isComplete
            ? t("cloud.createAgent.ready", {
                defaultValue: "Your agent is ready",
              })
            : hasError
              ? t("cloud.createAgent.wentWrong", {
                  defaultValue: "Something went wrong",
                })
              : t("cloud.createAgent.settingUp", {
                  defaultValue: "Setting up your agent…",
                })}
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

      <div className="relative space-y-0">
        {PROVISIONING_STEPS.map((step, i) => {
          const state = getStepState(i, activeIndex, hasError);
          const isLast = i === PROVISIONING_STEPS.length - 1;
          return (
            <div
              key={step.labelKey}
              className="flex items-start gap-3 relative"
            >
              {!isLast && (
                <div
                  className="absolute left-[11px] top-6 w-px"
                  style={{ height: "calc(100% - 2px)" }}
                >
                  <div
                    className={`h-full w-full transition-colors duration-500 ${
                      state === "complete"
                        ? "bg-green-500/30"
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
                      ? "text-green-400/80"
                      : state === "active"
                        ? "text-white"
                        : state === "error"
                          ? "text-red-400"
                          : "text-white/25"
                  }`}
                >
                  {t(step.labelKey, { defaultValue: step.defaultLabel })}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {hasError && error && (
        <div className="border border-red-500/20 bg-red-500/5 px-3 py-2.5 space-y-2">
          <p className="text-sm text-red-400">{error}</p>
          <Button
            variant="ghost"
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 text-xs text-red-300 hover:text-white transition-colors"
          >
            <RotateCcw className="h-3 w-3" />
            {t("cloud.createAgent.retryProvisioning", {
              defaultValue: "Retry provisioning",
            })}
          </Button>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {isComplete ? (
          <>
            <BrandButton
              size="sm"
              onClick={() => openWebUIWithPairing(agentId)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("cloud.createAgent.openWebUi", {
                defaultValue: "Open Web UI",
              })}
            </BrandButton>
            <BrandButton variant="outline" size="sm" onClick={onClose}>
              {t("cloud.createAgent.done", { defaultValue: "Done" })}
            </BrandButton>
          </>
        ) : (
          <BrandButton variant="outline" size="sm" onClick={onClose}>
            {t("cloud.createAgent.close", { defaultValue: "Close" })}
          </BrandButton>
        )}
      </div>
    </div>
  );
}

interface CreateElizaAgentDialogProps {
  trigger?: ReactNode;
  onProvisionQueued?: (agentId: string, jobId: string) => void;
  /** Called after a sandbox is successfully created so the parent can refresh. */
  onCreated?: () => void | Promise<void>;
}

type CreatePhase = "form" | "creating" | "provisioning";

interface CreateAgentRequest {
  agentName: string;
  autoProvision: boolean;
  dockerImage?: string;
}

interface CreateAgentResponse {
  source?: string;
  data?: {
    id?: string;
    agentId?: string;
    sandboxId?: string;
    jobId?: string;
    status?: string;
    executionTier?: string;
  };
}

export function CreateElizaAgentDialog({
  trigger,
  onProvisionQueued,
  onCreated,
}: CreateElizaAgentDialogProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  // Execution mode is the user-facing primitive — Shared (no container,
  // multi-tenant cloud runtime) vs Dedicated (own Docker container). The
  // cloud-api derives the tier from the presence of `dockerImage` in the create
  // body: empty → shared, set → custom (Docker). This state translates the mode
  // into the body field, NOT in addition to it.
  const [executionMode, setExecutionMode] = useState<"shared" | "dedicated">(
    "shared",
  );
  const [flavorId, setFlavorId] = useState(getDefaultFlavor().id);
  const [customImage, setCustomImage] = useState("");
  const [autoStart, setAutoStart] = useState(true);
  const [phase, setPhase] = useState<CreatePhase>("form");
  const [error, setError] = useState<string | null>(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const [provisionStartTime, setProvisionStartTime] = useState<number | null>(
    null,
  );
  const [elapsedSec, setElapsedSec] = useState(0);

  const busy = phase === "creating";
  const isProvisioningPhase = phase === "provisioning";
  const selectedFlavor = getFlavorById(flavorId);
  const isCustom = flavorId === "custom";
  const isDedicated = executionMode === "dedicated";
  const resolvedDockerImage = isCustom
    ? customImage.trim()
    : selectedFlavor?.dockerImage;

  const pollResult = useSandboxStatusPoll(
    isProvisioningPhase ? createdAgentId : null,
    {
      intervalMs: 5_000,
      enabled: isProvisioningPhase,
    },
  );

  useEffect(() => {
    if (!provisionStartTime) {
      setElapsedSec(0);
      return;
    }
    const tick = () =>
      setElapsedSec(Math.floor((Date.now() - provisionStartTime) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [provisionStartTime]);

  useEffect(() => {
    if (isProvisioningPhase && pollResult.status === "running") {
      toast.success(
        t("cloud.createAgent.upAndRunning", {
          defaultValue: "Agent is up and running!",
        }),
      );
    }
  }, [isProvisioningPhase, pollResult.status, t]);

  function resetForm() {
    setAgentName("");
    setExecutionMode("shared");
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
    setTimeout(resetForm, 300);
    if (createdAgentId) {
      onCreated?.()?.catch(() => {
        // Best-effort refresh — parent will retry on next poll cycle.
      });
    }
  }

  async function handleCreate() {
    const trimmedName = agentName.trim();
    if (!trimmedName || busy) return;

    setError(null);
    setPhase("creating");

    try {
      const createBody: CreateAgentRequest = {
        agentName: trimmedName,
        autoProvision: autoStart,
      };
      // The cloud-api tiering rule (cloud/shared/agent-tier.ts) is: dockerImage
      // absent → tier=shared (no container). Present → tier=custom (own Docker
      // container). Send the image ONLY when the user picked "Dedicated".
      if (isDedicated && resolvedDockerImage) {
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
          (createData as { error?: string }).error ??
            t("cloud.createAgent.createFailed", {
              status: createRes.status,
              defaultValue: "Create failed ({{status}})",
            }),
        );
      }

      const createdAgent = createData as CreateAgentResponse;
      const agentId =
        createdAgent.data?.id ??
        createdAgent.data?.agentId ??
        createdAgent.data?.sandboxId;
      if (!agentId) {
        throw new Error(
          t("cloud.createAgent.noAgentId", {
            defaultValue: "Agent created but no agent id was returned",
          }),
        );
      }

      setCreatedAgentId(agentId);

      if (autoStart) {
        setPhase("provisioning");
        setProvisionStartTime(Date.now());

        const createJobId = createdAgent.data?.jobId;
        if (createJobId) {
          onProvisionQueued?.(agentId, createJobId);
          return;
        }

        if (
          createRes.status === 201 &&
          (createdAgent.data?.status === "running" ||
            createdAgent.source === "shared_runtime")
        ) {
          toast.success(
            t("cloud.createAgent.agentRunning", {
              defaultValue: "Agent is running",
            }),
          );
          handleClose();
          return;
        }

        const provisionRes = await fetch(
          `/api/v1/eliza/agents/${agentId}/provision`,
          {
            method: "POST",
          },
        );
        const provisionData = await provisionRes.json().catch(() => ({}));

        if (provisionRes.status === 202 || provisionRes.status === 409) {
          const jobId = (provisionData as { data?: { jobId?: string } }).data
            ?.jobId;
          if (jobId) {
            onProvisionQueued?.(agentId, jobId);
          }
        } else if (provisionRes.ok) {
          toast.success(
            t("cloud.createAgent.agentRunning", {
              defaultValue: "Agent is running",
            }),
          );
          handleClose();
        } else {
          toast.warning(
            (provisionData as { error?: string }).error ??
              t("cloud.createAgent.autoStartFailed", {
                defaultValue:
                  "Agent created, but auto-start failed. You can start it from the table.",
              }),
          );
          handleClose();
        }
      } else {
        toast.success(
          t("cloud.createAgent.agentCreated", {
            name: trimmedName,
            defaultValue: 'Agent "{{name}}" created',
          }),
        );
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
      const res = await fetch(
        `/api/v1/eliza/agents/${createdAgentId}/provision`,
        {
          method: "POST",
        },
      );
      const data = await res.json().catch(() => ({}));

      if (res.status === 202 || res.status === 409) {
        const jobId = (data as { data?: { jobId?: string } }).data?.jobId;
        if (jobId) {
          onProvisionQueued?.(createdAgentId, jobId);
        }
        toast.info(
          t("cloud.createAgent.retrying", {
            defaultValue: "Retrying provisioning…",
          }),
        );
      } else if (!res.ok) {
        toast.error(
          (data as { error?: string }).error ??
            t("cloud.createAgent.retryFailed", {
              defaultValue: "Retry failed",
            }),
        );
      }
    } catch (err) {
      toast.error(
        t("cloud.createAgent.retryFailedDetail", {
          message: err instanceof Error ? err.message : String(err),
          defaultValue: "Retry failed: {{message}}",
        }),
      );
    }
  }

  return (
    <>
      {trigger ? (
        <Button
          variant="ghost"
          type="button"
          className="contents"
          onClick={() => phase === "form" && setOpen(true)}
        >
          {trigger}
        </Button>
      ) : (
        <BrandButton size="sm" onClick={() => setOpen(true)} disabled={busy}>
          <Plus className="h-4 w-4" />
          {t("cloud.createAgent.newAgent", { defaultValue: "New Agent" })}
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
              {isProvisioningPhase
                ? t("cloud.createAgent.launchingAgent", {
                    defaultValue: "Launching Agent",
                  })
                : t("cloud.createAgent.newAgent", {
                    defaultValue: "New Agent",
                  })}
            </DialogTitle>
          </DialogHeader>

          {isProvisioningPhase && createdAgentId ? (
            <ProvisioningProgress
              status={pollResult.status}
              error={pollResult.error}
              agentId={createdAgentId}
              elapsedSec={elapsedSec}
              onClose={handleClose}
              onRetry={handleRetryProvision}
            />
          ) : (
            <>
              <div className="space-y-4 py-2">
                {/* Agent name */}
                <div className="space-y-1.5">
                  <Label
                    htmlFor="eliza-agent-name"
                    className="text-white/60 text-xs"
                  >
                    {t("cloud.createAgent.agentName", {
                      defaultValue: "Agent Name",
                    })}
                  </Label>
                  <Input
                    id="eliza-agent-name"
                    placeholder={t("cloud.createAgent.agentNamePlaceholder", {
                      defaultValue: "e.g. eliza-alpha",
                    })}
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    disabled={busy}
                    className="bg-black/40 border-white/10 text-white placeholder:text-white/25 "
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

                {/* Execution mode — Shared vs Dedicated. */}
                <div className="space-y-1.5">
                  <Label className="text-white/60 text-xs">
                    {t("cloud.createAgent.executionMode", {
                      defaultValue: "Execution mode",
                    })}
                  </Label>
                  <div
                    role="radiogroup"
                    aria-label={t("cloud.createAgent.executionMode", {
                      defaultValue: "Execution mode",
                    })}
                    className="grid grid-cols-2 gap-2"
                  >
                    <label
                      htmlFor="create-agent-execution-shared"
                      className={`flex flex-col items-start gap-1.5 border px-3 py-2.5 text-left transition-colors    ${
                        busy
                          ? "cursor-not-allowed opacity-50"
                          : "cursor-pointer"
                      } ${
                        !isDedicated
                          ? "border-[#FF5800]/60 bg-[#FF5800]/[0.06]"
                          : "border-white/10 bg-black/20 hover:border-white/20"
                      }`}
                    >
                      <Input
                        id="create-agent-execution-shared"
                        type="radio"
                        name="execution-mode"
                        checked={!isDedicated}
                        disabled={busy}
                        onChange={() => setExecutionMode("shared")}
                        className="sr-only"
                      />
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-sm text-white">
                          <Cloud className="h-3.5 w-3.5" />
                          {t("cloud.createAgent.modeSharedTitle", {
                            defaultValue: "Shared",
                          })}
                        </span>
                        <span className="text-[10px] font-mono text-white/35">
                          {t("cloud.createAgent.modeSharedPrice", {
                            defaultValue: "free",
                          })}
                        </span>
                      </div>
                      <p className="text-[11px] text-white/50 leading-snug">
                        {t("cloud.createAgent.modeSharedDescription", {
                          defaultValue:
                            "Multi-tenant runtime. No container. Best for chat, webhooks and cron agents.",
                        })}
                      </p>
                    </label>

                    <label
                      htmlFor="create-agent-execution-dedicated"
                      className={`flex flex-col items-start gap-1.5 border px-3 py-2.5 text-left transition-colors    ${
                        busy
                          ? "cursor-not-allowed opacity-50"
                          : "cursor-pointer"
                      } ${
                        isDedicated
                          ? "border-[#FF5800]/60 bg-[#FF5800]/[0.06]"
                          : "border-white/10 bg-black/20 hover:border-white/20"
                      }`}
                    >
                      <Input
                        id="create-agent-execution-dedicated"
                        type="radio"
                        name="execution-mode"
                        checked={isDedicated}
                        disabled={busy}
                        onChange={() => setExecutionMode("dedicated")}
                        className="sr-only"
                      />
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-sm text-white">
                          <Server className="h-3.5 w-3.5" />
                          {t("cloud.createAgent.modeDedicatedTitle", {
                            defaultValue: "Dedicated",
                          })}
                        </span>
                        <span className="text-[10px] font-mono text-white/35">
                          {formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE)}
                        </span>
                      </div>
                      <p className="text-[11px] text-white/50 leading-snug">
                        {t("cloud.createAgent.modeDedicatedDescription", {
                          defaultValue:
                            "Own Docker container on a Hetzner node. Required for custom images, always-on plugins (Discord/Telegram), or BYO runtime.",
                        })}
                      </p>
                    </label>
                  </div>
                </div>

                {/* Image selector — only meaningful when Dedicated. */}
                {isDedicated && (
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="eliza-flavor"
                      className="text-white/60 text-xs"
                    >
                      {t("cloud.createAgent.image", { defaultValue: "Image" })}
                    </Label>
                    <Select
                      value={flavorId}
                      onValueChange={setFlavorId}
                      disabled={busy}
                    >
                      <SelectTrigger
                        id="eliza-flavor"
                        className="bg-black/40 border-white/10 text-white"
                      >
                        <SelectValue
                          placeholder={t("cloud.createAgent.selectFlavor", {
                            defaultValue: "Select image",
                          })}
                        />
                      </SelectTrigger>
                      <SelectContent className="border-white/10 bg-neutral-900">
                        {getAgentFlavorsForEnv().map((flavor: AgentFlavor) => (
                          <SelectItem key={flavor.id} value={flavor.id}>
                            <div className="flex flex-col">
                              <span>{flavor.name}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedFlavor && (
                      <p className="text-[11px] text-white/35">
                        {selectedFlavor.description}
                      </p>
                    )}
                  </div>
                )}

                {/* Custom image URL — appears only when Dedicated AND Custom. */}
                {isDedicated && isCustom && (
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="eliza-custom-image"
                      className="text-white/60 text-xs"
                    >
                      {t("cloud.createAgent.dockerImage", {
                        defaultValue: "Docker Image",
                      })}
                    </Label>
                    <Input
                      id="eliza-custom-image"
                      placeholder={t(
                        "cloud.createAgent.dockerImagePlaceholder",
                        {
                          defaultValue: "e.g. myregistry/agent:latest",
                        },
                      )}
                      value={customImage}
                      onChange={(e) => setCustomImage(e.target.value)}
                      disabled={busy}
                      className="bg-black/40 border-white/10 text-white placeholder:text-white/25"
                      maxLength={256}
                    />
                  </div>
                )}

                {/* Auto-start toggle — only meaningful for Dedicated agents. */}
                {isDedicated && (
                  <div className="flex items-center justify-between gap-4 border border-white/10 bg-black/20 px-3 py-2.5">
                    <div className="space-y-0.5">
                      <Label
                        htmlFor="eliza-auto-start"
                        className="text-sm text-white/70"
                      >
                        {t("cloud.createAgent.startImmediately", {
                          defaultValue: "Start container immediately",
                        })}
                      </Label>
                      <p className="text-[11px] text-white/35">
                        {t("cloud.createAgent.startAfterCreation", {
                          defaultValue:
                            "Provision the Hetzner node and boot the container right after create.",
                        })}
                      </p>
                    </div>
                    <Switch
                      id="eliza-auto-start"
                      checked={autoStart}
                      onCheckedChange={setAutoStart}
                      disabled={busy}
                    />
                  </div>
                )}

                {/* Cost notice */}
                {isDedicated && autoStart ? (
                  <div className="flex items-start gap-2.5 border border-[#FF5800]/15 bg-[#FF5800]/5 px-3 py-2.5">
                    <div className="shrink-0 mt-0.5 w-1.5 h-1.5 bg-[#FF5800] rounded-full" />
                    <div className="space-y-0.5">
                      <p className="text-[11px] font-mono text-white/70">
                        {t("cloud.createAgent.hourlyRates", {
                          running: formatHourlyRate(
                            AGENT_PRICING.RUNNING_HOURLY_RATE,
                          ),
                          idle: formatHourlyRate(
                            AGENT_PRICING.IDLE_HOURLY_RATE,
                          ),
                          defaultValue:
                            "{{running}}/hr running · {{idle}}/hr idle",
                        })}
                      </p>
                      <p className="text-[10px] font-mono text-white/35">
                        {t("cloud.createAgent.minDeposit", {
                          amount: formatUSD(AGENT_PRICING.MINIMUM_DEPOSIT),
                          defaultValue: "Min. deposit {{amount}}",
                        })}
                      </p>
                    </div>
                  </div>
                ) : !isDedicated ? (
                  <div className="flex items-start gap-2.5 border border-white/10 bg-black/20 px-3 py-2.5">
                    <div className="shrink-0 mt-0.5 w-1.5 h-1.5 bg-white/40 rounded-full" />
                    <p className="text-[11px] font-mono text-white/55 leading-snug">
                      {t("cloud.createAgent.sharedCostNote", {
                        defaultValue:
                          "No compute cost. You only pay for LLM tokens consumed by the agent.",
                      })}
                    </p>
                  </div>
                ) : null}

                {/* Inline error */}
                {error && (
                  <div className="border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-400">
                    {error}
                  </div>
                )}
              </div>

              <DialogFooter>
                <BrandButton
                  variant="outline"
                  onClick={handleClose}
                  disabled={busy}
                >
                  {t("cloud.createAgent.cancel", { defaultValue: "Cancel" })}
                </BrandButton>
                <BrandButton
                  onClick={() => void handleCreate()}
                  disabled={
                    !agentName.trim() ||
                    busy ||
                    (isDedicated && isCustom && !customImage.trim())
                  }
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy
                    ? t("cloud.createAgent.creating", {
                        defaultValue: "Creating…",
                      })
                    : isDedicated
                      ? autoStart
                        ? t("cloud.createAgent.deployDedicated", {
                            defaultValue: "Deploy Docker container",
                          })
                        : t("cloud.createAgent.createDedicated", {
                            defaultValue: "Create (don't start)",
                          })
                      : t("cloud.createAgent.createShared", {
                          defaultValue: "Create shared agent",
                        })}
                </BrandButton>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
