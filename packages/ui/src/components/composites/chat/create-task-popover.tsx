import { Code2, X } from "lucide-react";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Textarea } from "../../ui/textarea";

const DEFAULT_AGENT_TYPES = ["claude", "gemini", "codex", "aider"] as const;

type AgentType = (typeof DEFAULT_AGENT_TYPES)[number];

export interface CreateTaskPopoverProps {
  chatInput: string;
  disabled: boolean;
  onCreateTask: (description: string, agentType: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  triggerClassName?: string;
  triggerIconClassName?: string;
  triggerVariant?: ComponentProps<typeof Button>["variant"];
}

export function CreateTaskPopover({
  chatInput,
  disabled,
  onCreateTask,
  t,
  triggerClassName,
  triggerIconClassName,
  triggerVariant = "surface",
}: CreateTaskPopoverProps) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("claude");
  const previouslyOpenRef = useRef(false);

  useEffect(() => {
    if (open && !previouslyOpenRef.current && chatInput.trim()) {
      setDescription(chatInput.trim());
    }
    previouslyOpenRef.current = open;
  }, [chatInput, open]);

  const handleCreate = useCallback(() => {
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      return;
    }
    onCreateTask(trimmedDescription, agentType);
    setDescription("");
    setAgentType("claude");
    setOpen(false);
  }, [agentType, description, onCreateTask]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={triggerVariant}
          size="icon"
          className={triggerClassName ?? "h-[46px] w-[46px] shrink-0"}
          disabled={disabled}
          aria-label={t("chat.createTask", {
            defaultValue: "Create coding task",
          })}
          title={t("chat.createTask", {
            defaultValue: "Create coding task",
          })}
        >
          <Code2 className={triggerIconClassName ?? "h-4 w-4"} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-80 p-0"
      >
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-txt-strong">
              {t("chat.createTaskTitle", {
                defaultValue: "Create Coding Task",
              })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setOpen(false)}
              aria-label={t("common.close", { defaultValue: "Close" })}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("chat.taskDescriptionPlaceholder", {
              defaultValue: "Describe what to build...",
            })}
            className="min-h-[80px] resize-none text-sm"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                handleCreate();
              }
            }}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="chat-task-agent-type"
              className="text-xs text-muted-foreground"
            >
              {t("common.agent", { defaultValue: "Agent" })}
            </label>
            <Select
              value={agentType}
              onValueChange={(value: string) =>
                setAgentType(value as AgentType)
              }
            >
              <SelectTrigger id="chat-task-agent-type" className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEFAULT_AGENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={handleCreate} disabled={!description.trim()}>
            {t("common.create", { defaultValue: "Create" })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
