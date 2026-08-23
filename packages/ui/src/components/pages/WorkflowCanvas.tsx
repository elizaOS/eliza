/**
 * Renders Smithers step manifests as a compact dependency graph whose live
 * state follows elizaOS execution events and whose authoring actions route to chat.
 */
import {
  Background,
  Controls,
  Handle,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import {
  Bot,
  Check,
  Clock3,
  GitBranch,
  LayoutDashboard,
  MessageSquareText,
  Plus,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import type {
  WorkflowExecution,
  WorkflowStepManifest,
} from "../../api/client-types-chat";
import { Button } from "../ui/button";
import {
  type WorkflowCanvasNode,
  workflowStepsToFlow,
} from "./workflow-canvas-graph";

function StepIcon({ kind }: { kind: WorkflowStepManifest["kind"] }) {
  if (kind === "branch" || kind === "parallel")
    return <GitBranch className="h-4 w-4" />;
  if (kind === "approval") return <Check className="h-4 w-4" />;
  if (kind === "timer") return <Clock3 className="h-4 w-4" />;
  if (kind === "ui") return <LayoutDashboard className="h-4 w-4" />;
  if (kind === "workflow") return <WorkflowIcon className="h-4 w-4" />;
  return <Bot className="h-4 w-4" />;
}

function WorkflowStepNode({ data, selected }: NodeProps<WorkflowCanvasNode>) {
  const { step, state } = data;
  return (
    <div
      className={`flex min-w-48 items-center gap-3 rounded-xl bg-card/95 p-3 shadow-sm transition ${
        selected
          ? "shadow-[0_0_0_2px_hsl(var(--primary)/0.7)]"
          : state === "failed"
            ? "shadow-[0_0_0_2px_hsl(var(--destructive)/0.6)]"
            : state === "running"
              ? "shadow-[0_0_0_2px_hsl(var(--primary)/0.7)]"
              : state === "waiting"
                ? "shadow-[0_0_0_2px_rgb(245_158_11/0.6)]"
                : ""
      }`}
      title={[step.kind, step.agent, step.description]
        .filter(Boolean)
        .join(" · ")}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!border-0 !bg-transparent !opacity-0"
      />
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <StepIcon kind={step.kind} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {step.label}
      </span>
      {state !== "idle" ? (
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            state === "failed"
              ? "bg-destructive"
              : state === "finished"
                ? "bg-status-success"
                : state === "waiting"
                  ? "bg-amber-500"
                  : "animate-pulse bg-primary"
          }`}
          title={state}
        >
          <span className="sr-only">{state}</span>
        </span>
      ) : null}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!border-0 !bg-transparent !opacity-0"
      />
    </div>
  );
}

const nodeTypes = { workflowStep: memo(WorkflowStepNode) };

export function WorkflowCanvas({
  steps,
  execution,
  onEditStep,
  onAddStep,
}: {
  steps: WorkflowStepManifest[];
  execution: WorkflowExecution | null;
  onEditStep: (step: WorkflowStepManifest) => void;
  onAddStep: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const flow = useMemo(
    () => workflowStepsToFlow(steps, execution),
    [steps, execution],
  );
  const selected = steps.find((step) => step.id === selectedId) ?? null;

  return (
    <div
      data-testid="smithers-canvas"
      className="relative h-full min-h-72 overflow-hidden rounded-xl bg-muted/10"
    >
      {steps.length > 0 ? (
        <ReactFlow
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          fitViewOptions={{ padding: 0.25, minZoom: 0.65, maxZoom: 1.2 }}
          minZoom={0.35}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} color="hsl(var(--border))" />
          <Controls
            showInteractive={false}
            position="top-left"
            className="!overflow-hidden !rounded-lg !border-0 !bg-card/90 !shadow-sm [&_button]:!border-0 [&_button]:!bg-card/90 [&_button]:!fill-foreground [&_button:hover]:!bg-primary/15"
          />
        </ReactFlow>
      ) : (
        <button
          type="button"
          className="grid h-full w-full place-items-center text-muted-foreground/50"
          onClick={onAddStep}
          aria-label="Add first step with Eliza"
        >
          <Plus className="h-8 w-8" />
        </button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute right-3 top-3 z-10 rounded-full bg-card/90 shadow-sm hover:bg-primary/15"
        onClick={onAddStep}
        aria-label="Add step with Eliza"
        title="Add step"
      >
        <Plus className="h-4 w-4" />
      </Button>
      {selected ? (
        <Button
          variant="ghost"
          className="absolute bottom-3 left-1/2 z-10 max-w-[calc(100%-6rem)] -translate-x-1/2 gap-2 rounded-full bg-card/95 px-3 shadow-lg hover:bg-primary/15"
          onClick={() => onEditStep(selected)}
          title={[selected.kind, selected.agent, selected.description]
            .filter(Boolean)
            .join(" · ")}
        >
          <MessageSquareText className="h-3.5 w-3.5" />
          <span className="truncate text-xs">{selected.label}</span>
        </Button>
      ) : null}
    </div>
  );
}
