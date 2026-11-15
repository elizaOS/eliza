// The studio's page: the specs, the selected one, and where the project stands. README, "Studio".
import { useEffect, useState } from "react";
import { Alert, Button, EmptyState, Skeleton, cn } from "@repo/ui";
import { S, can, connect, current, dirtySpecs, doneEditing, focusLater, focusRow, publish, redraw, undo, useStudio } from "./studio.ts";
import { Ask, Build, PublishDialog } from "./Build.tsx";
import { Rail } from "./Rail.tsx";
import { Spec } from "./Spec.tsx";
import { Components } from "./Components.tsx";

export function App() {
  useStudio();
  const [publishing, setPublishing] = useState(false);
  const openPublish = () => { if (!S.publishing && can({ type: "publish", changes: 0 })) setPublishing(true); };

  useEffect(() => {
    connect();
    const keys = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
      if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); openPublish(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "z" && !typing && S.history.length) { e.preventDefault(); undo(); }
      else if (e.key === "Escape" && typing && S.editing.size && !document.querySelector("[role=dialog]")) {
        const id = document.activeElement?.closest<HTMLElement>("[data-uid]")?.dataset.uid;
        if (id && S.editing.has(id)) { doneEditing(id); focusRow(id); }
      }
    };
    // spec/index.md, "Edits stay in the page until they are published or discarded"
    const leaving = (e: BeforeUnloadEvent) => { if (dirtySpecs().length) e.preventDefault(); };
    document.addEventListener("keydown", keys);
    window.addEventListener("beforeunload", leaving);
    return () => { document.removeEventListener("keydown", keys); window.removeEventListener("beforeunload", leaving); };
  }, []);

  const spec = current();
  return (
    <>
      <div className="grid h-screen grid-cols-[240px_minmax(0,1fr)_340px] max-lg:h-auto max-lg:grid-cols-[200px_minmax(0,1fr)] max-sm:grid-cols-1">
        <Rail />
        <main className="overflow-auto px-8 pt-6 pb-30 max-sm:px-4">
          {S.offline && <Alert variant="warn" className="mb-4">Disconnected</Alert>}
          {S.snap?.problem && <Alert variant="destructive" className="mb-4 whitespace-pre-wrap">{S.snap.problem}</Alert>}
          {!S.snap ? <div className="mx-auto flex max-w-230 flex-col gap-4"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
            : S.view === "components" && S.components ? <Components index={S.components} />
            : spec ? <Spec spec={spec} />
            : !S.snap.problem && <EmptyState title="No specs yet"><Button variant="outline" onClick={() => focusLater("[data-newspec]")}>New spec</Button></EmptyState>}
        </main>
        <div className="flex max-lg:col-span-full [&>aside]:flex-1">
          <Build onPublish={openPublish} />
        </div>
      </div>
      <PublishDialog open={publishing} onOpenChange={setPublishing} />
      <Ask open={S.overwrite.length > 0} onOpenChange={() => { S.overwrite = []; redraw(); }} title={`${S.overwrite.join(", ")} changed on disk`} action="Overwrite" onConfirm={() => void publish(true)} />
      <div role="status" aria-live="polite"
        className={cn("fixed bottom-6 left-1/2 z-20 flex max-w-[80vw] -translate-x-1/2 items-center gap-3 rounded-lg bg-foreground px-3.5 py-2 text-background transition-all duration-base",
          S.toast ? "opacity-100" : "pointer-events-none translate-y-5 opacity-0")}>
        <span>{S.toast?.text}</span>
        {S.toast?.action && <button type="button" className="font-semibold underline" onClick={() => { S.toast!.action!.run(); }}>{S.toast.action.label}</button>}
      </div>
    </>
  );
}
