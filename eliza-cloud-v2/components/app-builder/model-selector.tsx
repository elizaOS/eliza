"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { ChevronDown, Sparkles, Zap, Brain, Cpu } from "lucide-react";
import {
  APP_BUILDER_MODELS,
  DEFAULT_APP_BUILDER_MODEL,
} from "@/lib/app-builder/types";
import type { AppBuilderModel } from "@/lib/app-builder/types";

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (modelId: string) => void;
  disabled?: boolean;
  compact?: boolean;
}

const getProviderIcon = (provider: string) => {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return <Sparkles className="h-3.5 w-3.5" />;
    case "openai":
      return <Brain className="h-3.5 w-3.5" />;
    case "google":
      return <Zap className="h-3.5 w-3.5" />;
    default:
      return <Cpu className="h-3.5 w-3.5" />;
  }
};

const getProviderColor = (provider: string) => {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return "text-orange-500";
    case "openai":
      return "text-green-500";
    case "google":
      return "text-blue-500";
    default:
      return "text-gray-500";
  }
};

export function ModelSelector({
  selectedModel,
  onModelChange,
  disabled = false,
  compact = false,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);

  const currentModel =
    APP_BUILDER_MODELS.find((m) => m.id === selectedModel) ||
    APP_BUILDER_MODELS.find((m) => m.id === DEFAULT_APP_BUILDER_MODEL) ||
    APP_BUILDER_MODELS[0];

  const handleSelect = (model: AppBuilderModel) => {
    onModelChange(model.id);
    setIsOpen(false);
  };

  if (compact) {
    return (
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground gap-1"
            disabled={disabled}
          >
            <span className="max-w-[80px] truncate">{currentModel.name}</span>
            <ChevronDown className="h-3 w-3 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[280px]">
          {APP_BUILDER_MODELS.map((model) => (
            <DropdownMenuItem
              key={model.id}
              onClick={() => handleSelect(model)}
              className="flex items-start gap-2 py-2"
            >
              <span className={`mt-0.5 ${getProviderColor(model.provider)}`}>
                {getProviderIcon(model.provider)}
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-xs">{model.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {model.description}
                </span>
              </div>
              {model.id === selectedModel && (
                <span className="ml-auto text-xs text-primary">✓</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          size="sm"
          className="h-9 px-3 gap-2"
          disabled={disabled}
        >
          <span className={getProviderColor(currentModel.provider)}>
            {getProviderIcon(currentModel.provider)}
          </span>
          <span>{currentModel.name}</span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[320px]">
        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
          Select AI Model
        </div>
        {APP_BUILDER_MODELS.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onClick={() => handleSelect(model)}
            className="flex items-start gap-3 py-3 px-3"
          >
            <span className={`mt-0.5 ${getProviderColor(model.provider)}`}>
              {getProviderIcon(model.provider)}
            </span>
            <div className="flex flex-col gap-1 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{model.name}</span>
                <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  {model.provider}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {model.description}
              </span>
            </div>
            {model.id === selectedModel && (
              <span className="text-primary font-medium">✓</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ModelSelector;
