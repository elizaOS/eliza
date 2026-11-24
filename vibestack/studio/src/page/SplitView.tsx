// Side-by-side Layout <-> State Graph split view bridged live through `postSim` (`gen/<module>.ts`).
import { useMemo, useState } from "react";
import { Button, EmptyState, cn, focusRing } from "@repo/ui";
import type { Component, ComponentIndex } from "../../../stories/emit.ts";
import type { SpecModelGraph } from "../graph.ts";
import {
  CompositionStrip, LivePreviewStage, SimStateBar, type Hierarchy,
  buildHierarchy, buildStageArgs, descendantsOf, dispatchPreviewAction, isLayoutComponent, useModelSim, usePreviewHost,
} from "./Components.tsx";
import { StateGraphCanvas } from "./StateGraph.tsx";
import { graphOf, openComponent, openStateFocus, type Working } from "./studio.ts";

function pickLayoutRoot(spec: Working | undefined, index: ComponentIndex, hierarchy: Hierarchy): Component | undefined {
  const isRoot = (c: Component) => !c.part && !hierarchy.parentOf.has(c.name);
  if (spec) {
    const exactRootWithChildren = index.components.find((c) => c.model?.spec === spec.file && isRoot(c) && Boolean(c.children?.length));
    if (exactRootWithChildren) return exactRootWithChildren;
    const exactRoot = index.components.find((c) => c.model?.spec === spec.file && isRoot(c));
    if (exactRoot) return exactRoot;
    const exactAny = index.components.find((c) => c.model?.spec === spec.file);
    if (exactAny) return exactAny;
  }
  return index.components.find((c) => isRoot(c) && Boolean(c.children?.length) && Boolean(c.model))
    ?? index.components.find((c) => isRoot(c) && isLayoutComponent(c, hierarchy))
    ?? index.components.find((c) => Boolean(c.model))
    ?? index.components[0];
}

export function SplitView({
  spec,
  graph,
  index,
}: {
  spec: Working | undefined;
  graph: SpecModelGraph | undefined;
  index: ComponentIndex | undefined;
}) {
  const preview = usePreviewHost();
  const hierarchy = useMemo(() => (index ? buildHierarchy(index) : undefined), [index]);
  const layoutRoot = useMemo(
    () => (index && hierarchy ? pickLayoutRoot(spec, index, hierarchy) : undefined),
    [spec, index, hierarchy],
  );

  const descendants = useMemo(
    () => (layoutRoot && hierarchy ? descendantsOf(layoutRoot, hierarchy) : []),
    [layoutRoot, hierarchy],
  );
  const defaultInspected = useMemo(
    () => descendants.find((c) => Boolean(c.uses?.length)) ?? layoutRoot,
    [descendants, layoutRoot],
  );

  const [selectedByRoot, setSelectedByRoot] = useState<{ rootId: string; name: string }>();
  const [presetByRoot, setPresetByRoot] = useState<{ rootId: string; at: number }>();
  const [inspect, setInspect] = useState(true);
  const [selectedNode, setSelectedNode] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [lastAction, setLastAction] = useState<string>();

  const inspectedName = layoutRoot && selectedByRoot?.rootId === layoutRoot.id
    ? selectedByRoot.name
    : defaultInspected?.name;
  const inspected = (inspectedName && hierarchy?.byName.get(inspectedName)) ?? layoutRoot;

  const activeGraph = useMemo(() => {
    if (graph && graph.nodes.length > 0) return graph;
    if (layoutRoot?.model) return graphOf(layoutRoot.model.spec) ?? graph;
    return graph;
  }, [graph, layoutRoot]);

  const activeModule = activeGraph?.module ?? layoutRoot?.model?.module;
  const { sim, busy, step, reset } = useModelSim(activeModule);

  const presetIndex = layoutRoot && presetByRoot?.rootId === layoutRoot.id ? presetByRoot.at : 0;
  const activeStory = layoutRoot?.stories[presetIndex] ?? layoutRoot?.stories[0];
  const stageArgs = useMemo(
    () => (layoutRoot ? buildStageArgs(layoutRoot, activeStory, sim?.state) : {}),
    [layoutRoot, activeStory, sim?.state],
  );

  const highlightTransitions = useMemo(() => {
    if (!inspected) return [];
    if (inspected.uses?.length) return inspected.uses;
    if (inspected === layoutRoot) {
      return [...new Set(descendants.flatMap((c) => c.uses ?? []))];
    }
    return [];
  }, [inspected, layoutRoot, descendants]);

  if (!index || !hierarchy || !layoutRoot || !inspected) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState title="No layout catalog available for split view" />
      </div>
    );
  }

  const handleSelectComponent = (name: string) => {
    if (hierarchy.byName.has(name)) {
      setSelectedByRoot({ rootId: layoutRoot.id, name });
    }
  };

  const handleAction = (prop: string, actionArgs: unknown[]) => {
    setLastAction(dispatchPreviewAction(prop, actionArgs, sim, step));
  };

  const bridgeLabel = activeModule
    ? `gen/${activeModule}.ts · ${inspected.name}`
    : inspected.name;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border max-lg:grid-cols-1 max-lg:divide-x-0 max-lg:divide-y">
        <section aria-label="Layout preview pane" className="flex min-h-0 flex-col bg-background">
          <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">Layout · {layoutRoot.name}</span>
              <div role="group" aria-label="Layout presets" className="flex items-center gap-1">
                {layoutRoot.stories.map((s, at) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={at === presetIndex}
                    onClick={() => setPresetByRoot({ rootId: layoutRoot.id, at })}
                    className={cn(
                      focusRing,
                      "rounded-sm px-2 py-0.5 text-xs transition-colors duration-fast hover:bg-accent",
                      at === presetIndex ? "bg-accent font-medium text-primary" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant={inspect ? "primary" : "outline"}
                size="sm"
                aria-pressed={inspect}
                className="h-7 px-2 text-xs"
                onClick={() => setInspect((v) => !v)}
              >
                Inspect {inspect ? "ON" : "OFF"}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => openComponent(inspected.id)}>
                Layout ↗
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
            <CompositionStrip
              root={layoutRoot}
              inspected={inspected}
              hierarchy={hierarchy}
              onSelectComponent={handleSelectComponent}
            />
            <LivePreviewStage
              target={layoutRoot}
              inspected={inspected}
              hierarchy={hierarchy}
              preview={preview}
              story={activeStory}
              args={stageArgs}
              inspect={inspect}
              viewport="desktop"
              compact
              onSelectComponent={handleSelectComponent}
              onAction={handleAction}
            />
          </div>
        </section>

        <section aria-label="State graph pane" className="flex min-h-0 flex-col bg-background">
          <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground">
                States · {activeGraph?.stateType ?? activeGraph?.module ?? "Model"}
              </span>
              {activeGraph?.projectionLabel && (
                <span className="font-mono text-xs text-muted-foreground">{activeGraph.projectionLabel}</span>
              )}
            </div>
            {activeGraph && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => openStateFocus(activeGraph.file, { node: selectedNode, edge: selectedEdge })}
              >
                States ↗
              </Button>
            )}
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
            {activeGraph && activeGraph.nodes.length > 0 ? (
              <StateGraphCanvas
                graph={activeGraph}
                activeNode={sim?.activeNode}
                selectedNode={selectedNode}
                selectedEdge={selectedEdge}
                highlightTransitions={highlightTransitions}
                showOverlays={{ guards: true, invariants: true, liveness: true }}
                onSelectNode={(id) => { setSelectedNode(id); setSelectedEdge(undefined); }}
                onSelectEdge={(id) => { setSelectedEdge(id); setSelectedNode(undefined); }}
                compact
              />
            ) : (
              <EmptyState title="No state machine for this spec" />
            )}
          </div>
        </section>
      </div>

      <SimStateBar
        label={bridgeLabel}
        sim={sim}
        busy={busy}
        highlightSymbols={highlightTransitions}
        lastAction={lastAction ?? (highlightTransitions.length ? `wired: ${highlightTransitions.join(", ")}` : undefined)}
        onStep={(event, by) => void step(event, by)}
        onReset={() => void reset()}
      />
    </div>
  );
}
