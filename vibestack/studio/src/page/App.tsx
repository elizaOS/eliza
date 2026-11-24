// The studio's page: 48px top pipeline bar, 224px left rail, active lens canvas (Stories, States, Layout, Split),
// on-demand Activity Drawer, and ⌘K Command Palette. README, "Studio".
import { useEffect, useState } from "react";
import { Alert, Button, EmptyState, Skeleton, cn } from "@repo/ui";
import {
  S, can, connect, current, dirtySpecs, doneEditing, focusLater, focusRow, graphOf, publish, redraw, setCmdOpen,
  setDrawer, undo, useStudio,
} from "./studio.ts";
import { Ask, BuildDrawer, CommandPalette, PublishDialog, TopBar } from "./Build.tsx";
import { Rail } from "./Rail.tsx";
import { Spec } from "./Spec.tsx";
import { Components } from "./Components.tsx";
import { StateGraph } from "./StateGraph.tsx";
import { SplitView } from "./SplitView.tsx";

export function App() {
  useStudio();
  const [publishing, setPublishing] = useState(false);
  const openPublish = () => { if (!S.publishing && can({ type: "publish", changes: 0 })) setPublishing(true); };

  useEffect(() => {
    connect();
    const keys = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); openPublish(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen(!S.cmdOpen); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing && S.history.length) { e.preventDefault(); undo(); }
      else if (e.key === "Escape" && !document.querySelector("[role=dialog]")) {
        if (typing && S.editing.size) {
          const id = document.activeElement?.closest<HTMLElement>("[data-uid]")?.dataset.uid;
          if (id && S.editing.has(id)) { doneEditing(id); focusRow(id); }
        } else if (S.drawer) {
          setDrawer(false);
        }
      }
    };
    // spec/index.md, "Edits stay in the page until they are published or discarded"
    const leaving = (e: BeforeUnloadEvent) => { if (dirtySpecs().length) e.preventDefault(); };
    document.addEventListener("keydown", keys);
    window.addEventListener("beforeunload", leaving);
    return () => { document.removeEventListener("keydown", keys); window.removeEventListener("beforeunload", leaving); };
  }, []);

  const spec = current();
  const graph = spec ? graphOf(spec.file) : undefined;
  return (
    <>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground max-sm:h-auto max-sm:min-h-screen">
        <TopBar onPublish={openPublish} />
        <div className="flex min-h-0 flex-1 overflow-hidden max-sm:flex-col">
          <Rail />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {(S.offline || S.snap?.problem) && (
              <div className="flex flex-none flex-col gap-2 px-6 pt-4">
                {S.offline && <Alert variant="warn">Disconnected</Alert>}
                {S.snap?.problem && <Alert variant="destructive" className="whitespace-pre-wrap">{S.snap.problem}</Alert>}
              </div>
            )}
            {!S.snap ? (
              <div className="mx-auto flex w-full max-w-220 flex-col gap-4 px-8 pt-6"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
            ) : S.view === "components" && S.components ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden"><Components index={S.components} /></div>
            ) : S.view === "split" && S.components ? (
              <SplitView spec={spec} graph={graph} index={S.components} />
            ) : S.view === "states" && spec ? (
              <StateGraph spec={spec} graph={graph} />
            ) : spec ? (
              <Spec spec={spec} />
            ) : !S.snap.problem ? (
              <div className="flex flex-1 items-center justify-center p-8">
                <EmptyState title="No specs yet"><Button variant="outline" onClick={() => focusLater("[data-newspec]")}>New spec</Button></EmptyState>
              </div>
            ) : null}
          </main>
        </div>
      </div>
      <BuildDrawer />
      <CommandPalette />
      <PublishDialog open={publishing} onOpenChange={setPublishing} />
      <Ask open={S.overwrite.length > 0} onOpenChange={() => { S.overwrite = []; redraw(); }} title={`${S.overwrite.join(", ")} changed on disk`} action="Overwrite" onConfirm={() => void publish(true)} />
      <div role="status" aria-live="polite"
        className={cn("fixed bottom-6 left-1/2 z-40 flex max-w-[80vw] -translate-x-1/2 items-center gap-3 rounded-lg bg-foreground px-3.5 py-2 text-background transition-all duration-base",
          S.toast ? "opacity-100" : "pointer-events-none translate-y-5 opacity-0")}>
        <span>{S.toast?.text}</span>
        {S.toast?.action && <button type="button" className="font-semibold underline" onClick={() => { S.toast!.action!.run(); }}>{S.toast.action.label}</button>}
      </div>
    </>
  );
}
