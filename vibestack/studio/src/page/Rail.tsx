// The specs of the project, as a tree: where each stands, which is shown, and a new one by its path.
import { useState } from "react";
import { Input, Skeleton, cn, focusRing } from "@repo/ui";
import { S, deleteSpec, failures, find, isDirty, move, newSpec, redraw, reviewCount, select, specLabel } from "./studio.ts";
import { Dot, IconButton, type Mark } from "./text.tsx";
import { dragging } from "./Spec.tsx";

export function Rail() {
  const fails = failures().bySpec;
  const [name, setName] = useState("");
  const [over, setOver] = useState("");
  const create = () => { if (name.trim()) { newSpec(name.trim()); setName(""); } };
  return (
    <aside aria-label="Specs" className="flex flex-col gap-2 overflow-auto border-r border-border bg-card px-3 py-4">
      <nav aria-label="Projects" className="flex flex-col px-2">
        {S.projects.map((p) => (p.id === S.project ? <span key={p.id} aria-current="page" className="font-semibold">{p.name}</span>
          : <a key={p.id} href={`?project=${encodeURIComponent(p.id)}`} className="text-muted-foreground hover:text-foreground">{p.name}</a>))}
      </nav>
      {!S.snap && <div className="flex flex-col gap-2 px-2"><Skeleton /><Skeleton /><Skeleton /></div>}
      <ul className="m-0 mt-2 flex list-none flex-col gap-0.5 p-0">
        {S.specs.map((spec) => {
          const review = reviewCount(spec.file);
          const [mark, label]: [Mark, string] = isDirty(spec) ? ["dirty", "unpublished changes"] : fails.has(spec.file) ? ["bad", "failing checks"] : review ? ["review", `${review} to review`] : ["", ""];
          const depth = specLabel(spec.file).split("/").length - (spec.file === "spec/index.md" ? 1 : 0);
          // A story dropped on a spec moves to its end.
          const accepts = () => dragging?.kind === "story" && !spec.deleted && find(dragging.uid)?.spec.file !== spec.file;
          return (
            <li key={spec.file} style={{ paddingLeft: 8 + 12 * depth }}
              onDragOver={(e) => { if (accepts()) { e.preventDefault(); setOver(spec.file); } }} onDragLeave={() => setOver("")}
              onDrop={(e) => { e.preventDefault(); setOver(""); if (dragging) move(dragging.uid, { spec: spec.file }); }}
              className={cn("flex items-center gap-2 rounded-md border border-transparent pr-1 hover:bg-accent", S.view === "specs" && spec.file === S.sel && "bg-accent", over === spec.file && "border-dashed border-primary")}>
              <button type="button" title={spec.file} aria-current={S.view === "specs" && spec.file === S.sel} onClick={() => select(spec.file)}
                className={cn(focusRing, "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left")}>
                <Dot mark={mark} label={label} />
                <span className={cn("flex-1 truncate font-mono text-sm", spec.deleted && "text-muted-foreground line-through")}>{specLabel(spec.file).split("/").pop()}</span>
                <span title="stories · rules" className="text-xs text-muted-foreground tabular-nums">{spec.outline.stories.length}·{spec.outline.stories.reduce((n, s) => n + s.rules.length, 0)}</span>
              </button>
              {spec.deleted ? <IconButton name="undo" label={`Keep ${spec.file}`} onClick={() => deleteSpec(spec, false)} />
                : <IconButton name="trash" label={`Delete ${spec.file}`} danger onClick={() => deleteSpec(spec, true)} />}
            </li>
          );
        })}
      </ul>
      {S.components && (
        <button type="button" aria-current={S.view === "components"} onClick={() => { S.view = "components"; redraw(); }}
          className={cn("mt-2 flex items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-accent", S.view === "components" && "bg-accent")}>
          Components<span className="text-xs text-muted-foreground tabular-nums">{S.components.components.length}</span>
        </button>
      )}
      <div className="mt-2 flex gap-1">
        <Input data-newspec value={name} placeholder="area/child" aria-label="Path of a new spec" className="h-8 font-mono text-sm"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
        <IconButton name="plus" label="Add spec" onClick={create} />
      </div>
    </aside>
  );
}
