"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Loader2,
  Copy,
  Check,
  RefreshCw,
  Smartphone,
  Workflow,
  Server,
  Bot,
  ChevronRight,
  Globe,
  Zap,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { generateNameForType } from "@/lib/utils/random-names";
import { cn } from "@/lib/utils";
import {
  PostCreationAppPrompt,
  type EntityType,
} from "./post-creation-app-prompt";

export type QuickCreateType = "app" | "workflow" | "service" | "agent";

interface QuickCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType?: QuickCreateType;
  onCreated?: (result: CreatedResult) => void;
}

interface CreatedResult {
  id: string;
  type: QuickCreateType;
  name: string;
  apiKey?: string;
}

interface TypeOption {
  type: QuickCreateType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}

const TYPE_OPTIONS: TypeOption[] = [
  {
    type: "app",
    label: "App",
    description: "Web app or mobile experience",
    icon: Smartphone,
    color: "text-cyan-400",
  },
  {
    type: "agent",
    label: "AI Agent",
    description: "Conversational AI with personality",
    icon: Bot,
    color: "text-emerald-400",
  },
  {
    type: "workflow",
    label: "Workflow",
    description: "Automated task pipeline",
    icon: Workflow,
    color: "text-purple-400",
  },
  {
    type: "service",
    label: "Service",
    description: "API with MCP, A2A, REST endpoints",
    icon: Server,
    color: "text-orange-400",
  },
];

interface ServiceEndpoints {
  mcp: boolean;
  a2a: boolean;
  rest: boolean;
}

type Step = "type" | "configure" | "success";

export function QuickCreateDialog({
  open,
  onOpenChange,
  defaultType,
  onCreated,
}: QuickCreateDialogProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(defaultType ? "configure" : "type");
  const [selectedType, setSelectedType] = useState<QuickCreateType | null>(
    defaultType ?? null,
  );
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [createdResult, setCreatedResult] = useState<CreatedResult | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [serviceEndpoints, setServiceEndpoints] = useState<ServiceEndpoints>({
    mcp: true,
    a2a: true,
    rest: true,
  });
  const [showAppPrompt, setShowAppPrompt] = useState(false);

  const generateName = (type: QuickCreateType): string =>
    generateNameForType(type);

  const handleTypeSelect = (type: QuickCreateType) => {
    if (type === "agent") {
      router.push("/dashboard/build");
      onOpenChange(false);
      return;
    }
    if (type === "app") {
      router.push("/dashboard/apps/create");
      onOpenChange(false);
      return;
    }
    setSelectedType(type);
    setName(generateName(type));
    setStep("configure");
  };

  const regenerateName = () => {
    if (selectedType) {
      setName(generateName(selectedType));
    }
  };

  const handleCreate = async () => {
    if (!selectedType || !name.trim()) return;
    setIsLoading(true);

    const trimmedName = name.trim();
    let result: CreatedResult | null = null;

    const createApp = async (isService: boolean) => {
      const response = await fetch("/api/v1/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          description: `${isService ? "Service" : "Mini App"} created with Eliza Cloud`,
          app_url: "https://localhost:3000",
          features_enabled: {
            chat: true,
            agents: isService,
            embedding: isService,
          },
          metadata: {
            app_type: selectedType,
            ...(isService && { service_endpoints: serviceEndpoints }),
          },
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to create");
      }
      const data = await response.json();
      return {
        id: data.app.id,
        type: selectedType,
        name: trimmedName,
        apiKey: data.apiKey,
      } as CreatedResult;
    };

    const createAgent = async () => {
      const response = await fetch("/api/v1/app/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          bio: "A helpful AI assistant",
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to create agent");
      }
      const data = await response.json();
      return { id: data.agent.id, type: "agent" as const, name: trimmedName };
    };

    const createWorkflow = async () => {
      const response = await fetch("/api/v1/n8n/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          description: "Workflow created with Eliza Cloud",
          workflowData: { nodes: [], connections: {}, settings: {} },
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to create workflow");
      }
      const data = await response.json();
      return {
        id: data.workflow.id,
        type: "workflow" as const,
        name: trimmedName,
      };
    };

    try {
      switch (selectedType) {
        case "app":
          result = await createApp(false);
          break;
        case "service":
          result = await createApp(true);
          break;
        case "agent":
          result = await createAgent();
          break;
        case "workflow":
          result = await createWorkflow();
          break;
      }

      setCreatedResult(result);
      setStep("success");
      onCreated?.(result);
      toast.success(
        `${TYPE_OPTIONS.find((t) => t.type === selectedType)?.label} created`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Creation failed");
    } finally {
      setIsLoading(false);
    }
  };

  const copyApiKey = async () => {
    if (!createdResult?.apiKey) return;
    await navigator.clipboard.writeText(createdResult.apiKey);
    setCopied(true);
    toast.success("API key copied");
    setTimeout(() => setCopied(false), 2000);
  };

  const getNavigationPath = (): string => {
    if (!createdResult) return "/dashboard";
    switch (createdResult.type) {
      case "app":
      case "service":
        return `/dashboard/apps/${createdResult.id}`;
      case "agent":
        return `/dashboard/my-agents?edit=${createdResult.id}`;
      case "workflow":
        return `/dashboard/workflows?view=${createdResult.id}`;
    }
  };

  const handleClose = () => {
    if (createdResult) {
      router.push(getNavigationPath());
    }
    setStep(defaultType ? "configure" : "type");
    setSelectedType(defaultType ?? null);
    setName(defaultType ? generateName(defaultType) : "");
    setCreatedResult(null);
    setCopied(false);
    setServiceEndpoints({ mcp: true, a2a: true, rest: true });
    onOpenChange(false);
  };

  const handleBack = () => {
    if (defaultType) {
      onOpenChange(false);
    } else {
      setStep("type");
      setSelectedType(null);
      setName("");
    }
  };

  const canCreateApp = (
    type: QuickCreateType,
  ): type is "agent" | "workflow" | "service" => {
    return type === "agent" || type === "workflow" || type === "service";
  };

  const getEntityType = (type: QuickCreateType): EntityType | null => {
    if (type === "agent") return "agent";
    if (type === "workflow") return "workflow";
    if (type === "service") return "service";
    return null;
  };

  const handleCreateApp = () => {
    if (createdResult && canCreateApp(createdResult.type)) {
      setShowAppPrompt(true);
    }
  };

  if (step === "success" && createdResult) {
    const typeConfig = TYPE_OPTIONS.find((t) => t.type === createdResult.type);
    const TypeIcon = typeConfig?.icon ?? Smartphone;
    const entityType = getEntityType(createdResult.type);

    return (
      <>
        <Dialog open={open && !showAppPrompt} onOpenChange={handleClose}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Check className="h-5 w-5 text-green-500" />
                Created Successfully
              </DialogTitle>
            </DialogHeader>

            {createdResult.apiKey && (
              <div className="space-y-2 pt-2">
                <p className="text-sm font-medium text-[#FF5800]">
                  Copy your API key now — you won&apos;t see it again
                </p>
                <div className="flex gap-2">
                  <input
                    value={createdResult.apiKey}
                    readOnly
                    className="flex-1 h-11 px-3 rounded-xl bg-white/5 text-white font-mono text-sm select-all selection:bg-[#FF5800] selection:text-white focus:outline-none"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={copyApiKey}
                    className="h-11 w-11 rounded-xl shrink-0"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            )}

            <DialogFooter className="pt-2">
              <Button
                onClick={handleClose}
                className="w-full h-11 rounded-xl bg-[#FF5800] hover:bg-[#FF5800]/90 text-white"
              >
                Continue
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {entityType && (
          <PostCreationAppPrompt
            open={showAppPrompt}
            onOpenChange={setShowAppPrompt}
            entityType={entityType}
            entityId={createdResult.id}
            entityName={createdResult.name}
            onSkip={handleClose}
          />
        )}
      </>
    );
  }

  if (step === "configure" && selectedType) {
    const typeConfig = TYPE_OPTIONS.find((t) => t.type === selectedType);
    const TypeIcon = typeConfig?.icon ?? Smartphone;

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TypeIcon className={cn("h-5 w-5", typeConfig?.color)} />
              {selectedType === "service"
                ? "Service Configuration"
                : `${typeConfig?.label} Name`}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              {selectedType === "service" && (
                <Label className="text-white/80">Name</Label>
              )}
              <div className="flex gap-2">
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter a name..."
                  className="flex-1 h-11 rounded-xl"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={regenerateName}
                  title="Generate new name"
                  className="h-11 w-11 rounded-xl shrink-0"
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {selectedType === "service" && (
              <div className="space-y-3 pt-2">
                <Label className="text-white/80">Endpoints</Label>
                <div className="grid gap-2">
                  {[
                    {
                      key: "mcp" as const,
                      label: "MCP Server",
                      description: "Model Context Protocol",
                      icon: Bot,
                    },
                    {
                      key: "a2a" as const,
                      label: "A2A Protocol",
                      description: "Agent-to-Agent",
                      icon: Zap,
                    },
                    {
                      key: "rest" as const,
                      label: "REST API",
                      description: "Standard HTTP",
                      icon: Globe,
                    },
                  ].map(({ key, label, description, icon: Icon }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setServiceEndpoints((prev) => ({
                          ...prev,
                          [key]: !prev[key],
                        }))
                      }
                      className={cn(
                        "flex items-center gap-3 p-3 rounded-xl border transition-all text-left",
                        serviceEndpoints[key]
                          ? "border-[#FF5800]/50 bg-[#FF5800]/10"
                          : "border-white/10 bg-white/5 hover:bg-white/10",
                      )}
                    >
                      <div
                        className={cn(
                          "p-2 rounded-xl",
                          serviceEndpoints[key]
                            ? "bg-[#FF5800]/20"
                            : "bg-white/10",
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-4 w-4",
                            serviceEndpoints[key]
                              ? "text-[#FF5800]"
                              : "text-white/60",
                          )}
                        />
                      </div>
                      <div className="flex-1">
                        <div className="font-medium text-white text-sm">
                          {label}
                        </div>
                        <div className="text-xs text-white/50">
                          {description}
                        </div>
                      </div>
                      <div
                        className={cn(
                          "w-4 h-4 rounded-full border-2 flex items-center justify-center",
                          serviceEndpoints[key]
                            ? "border-[#FF5800] bg-[#FF5800]"
                            : "border-white/30",
                        )}
                      >
                        {serviceEndpoints[key] && (
                          <Check className="h-2.5 w-2.5 text-white" />
                        )}
                      </div>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-white/40">
                  All endpoints integrate with workflows and n8n
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="flex justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={handleBack}
              className="rounded-xl"
            >
              {defaultType ? "Cancel" : "Back"}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={isLoading || !name.trim()}
              className="w-24 rounded-xl bg-[#FF5800] hover:bg-[#FF5800]/90 text-white"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Create"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>What do you want to build?</DialogTitle>
          <DialogDescription>
            Start here. Connect other parts anytime.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 pt-4">
          {TYPE_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.type}
                onClick={() => handleTypeSelect(option.type)}
                className="flex items-center gap-4 p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/[0.07] hover:border-white/20 transition-all duration-300 text-left group"
              >
                <Icon className={cn("h-6 w-6", option.color)} />
                <div className="flex-1">
                  <div className="font-medium text-white">{option.label}</div>
                  <div className="text-sm text-white/60">
                    {option.description}
                  </div>
                </div>
                <ChevronRight className="h-5 w-5 text-white/30 group-hover:text-white/60 group-hover:translate-x-1 transition-all" />
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
