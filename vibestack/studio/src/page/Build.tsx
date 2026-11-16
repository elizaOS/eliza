// Where the project stands, and what can be done about it now: publish, sync with an agent, check, sign off. Every
// control is offered exactly when the session allows its event (spec/index.md).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Dialog, DialogClose, DialogContent, DialogTitle, Skeleton, Spinner, cn } from "@repo/ui";
import { headingsAreSound } from "../../gen/outline.ts";
import { SIGN, edits } from "../markdown.ts";
import type { JobView } from "../project.ts";
import { S, can, dirtySpecs, discard, failing, locate, publish, publishedText, reveal, stagesOf, start, toast, type StageMark } from "./studio.ts";
import { Code, Dot, Icon, IconButton, Markdown, Quint } from "./text.tsx";

const elapsed = (job: JobView, now: number) => { const s = Math.round(((job.finished ?? now) - job.started) / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
/** A running job's time, ticking. */
function Elapsed({ job }: { job: JobView }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (job.status !== "running") return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [job.status]);
  return <span className="text-xs text-muted-foreground tabular-nums">{elapsed(job, now)}</span>;
}

type StageState = "idle" | "todo" | "active" | "running" | "ok" | "bad";
const NODE: Record<Exclude<StageState, "running">, string> = {
  idle: "border-border", todo: "border-warn text-warn", active: "border-primary bg-primary text-primary-foreground",
  ok: "border-ok bg-ok text-card", bad: "border-destructive bg-destructive text-card",
};
const Stage = ({ name, state, mark, label }: { name: string; state: StageState; mark: string | number; label: string }) => (
  <div className="relative flex flex-col items-center gap-1.5 text-xs text-muted-foreground">
    {state === "running" ? <Spinner label={`${name}: running`} className="rounded-full bg-card text-primary" />
      : <div role="img" aria-label={`${name}: ${label}`} title={label} className={cn("grid size-6 place-items-center rounded-full border-2 bg-card text-xs font-bold tabular-nums", NODE[state])}>{mark}</div>}
    {name}
  </div>
);

const MARK: Record<Exclude<StageMark, "running">, [string, string]> = { passed: ["✓", "text-ok"], failed: ["✗", "text-destructive"], skipped: ["–", "text-muted-foreground"], "": ["·", "text-muted-foreground"] };
/** The stages of the last check, or the one running, as one row of marks. */
const Stages = ({ running }: { running: boolean }) => (
  <ol aria-label="Stages" className="m-0 flex list-none flex-wrap gap-x-2.5 gap-y-1 p-0 text-xs text-muted-foreground">
    {stagesOf(S.snap?.check?.results ?? [], running).map(({ stage, mark, simulated }) => {
      const label = `${stage}: ${mark || "not run"}${simulated ? `, ${simulated} obligations simulated only` : ""}`;
      return (
        <li key={stage} title={label} aria-label={label} className="flex items-center gap-1">
          {mark === "running" ? <Spinner size="sm" label={`${stage}: running`} className="size-3 text-primary" /> : <span aria-hidden className={cn("font-mono font-semibold", MARK[mark][1])}>{MARK[mark][0]}</span>}
          {stage}{simulated > 0 && <span className="text-warn tabular-nums">{simulated}</span>}
        </li>
      );
    })}
  </ol>
);

/** Line diff (../markdown.ts, `edits`), with three lines of context around each change. */
function diff(a: string, b: string) {
  const ops = edits(a.split("\n"), b.split("\n"));
  const near = ops.map((_, k) => ops.slice(Math.max(0, k - 3), k + 4).some(({ op }) => op !== " "));
  return ops.flatMap(({ op, item, at }, k) => near[k] ? [<div key={at} className={cn("px-2.5 whitespace-pre-wrap", op === "+" && "bg-ok/15", op === "-" && "bg-destructive/15")}>{`${op} ${item}`}</div>]
    : near[k - 1] || k === 0 ? [<div key={at} className="bg-muted px-2.5 text-muted-foreground">…</div>] : []);
}

/** A question before acting: what will happen, a way out, and the one action. `wide` for what needs reading. */
export function Ask({ open, onOpenChange, title, action, disabled = false, wide = false, onConfirm, children }:
  { open: boolean; onOpenChange: (open: boolean) => void; title: string; action: ReactNode; disabled?: boolean; wide?: boolean; onConfirm: () => void; children?: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn("max-h-[86vh] gap-0 p-0", wide && "max-w-230")}>
        <DialogTitle className="px-6 py-4 pr-12 leading-normal">{title}</DialogTitle>
        {children ? <div className="flex flex-col gap-4 overflow-auto border-t border-border px-6 py-4">{children}</div> : null}
        <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button disabled={disabled} onClick={() => { onOpenChange(false); onConfirm(); }}>{action}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What publishing writes: each changed spec's diff. Refused while a spec has a heading that is empty or not unique. */
export function PublishDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const dirty = dirtySpecs();
  const unsound = dirty.filter((s) => !s.deleted && !headingsAreSound(s.outline)).map((s) => s.file);
  return (
    <Ask wide open={open} onOpenChange={onOpenChange} title={`Publish ${dirty.length === 1 ? dirty[0].file : `${dirty.length} specs`}`}
      action={<><Icon name="check" />Publish</>} disabled={unsound.length > 0} onConfirm={() => void publish()}>
      {unsound.length > 0 && <Alert variant="destructive">{unsound.join(", ")}</Alert>}
      {dirty.map((spec) => (
        <div key={spec.file} className="overflow-auto rounded-md border border-border font-mono text-xs leading-normal">
          <div className="border-b border-border bg-muted px-2.5 py-1.5 font-semibold">{spec.deleted ? `${spec.file} (deleted)` : spec.orig === null ? `${spec.file} (new)` : spec.file}</div>
          {!spec.deleted && diff(spec.orig ?? "", publishedText(spec)!)}
        </div>
      ))}
    </Ask>
  );
}

/** Everything a sign-off records, to read before it does (spec/index.md, "Story: Sign off"). */
function ReviewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const review = S.snap?.review ?? [];
  return (
    <Ask wide open={open} onOpenChange={onOpenChange} title={`Sign off ${review.length}`}
      action={<><Icon name="check" />Sign off</>} disabled={!can({ type: "signOff" })} onConfirm={() => start("accept")}>
      {review.map((r) => (
        <section key={r.where} aria-label={r.where} className="flex flex-col gap-2">
          <h3 className="font-semibold">{r.where.replace(/^.*  (## )?/, "")} <span className="font-normal text-warn">{r.status}</span></h3>
          {r.prose && <Markdown text={r.prose} file={r.file ?? ""} className="text-muted-foreground" />}
          {r.quint && <Quint code={r.quint} />}
        </section>
      ))}
    </Ask>
  );
}

export function Build({ onPublish }: { onPublish: () => void }) {
  const logRef = useRef<HTMLPreElement>(null);
  const snap = S.snap;
  const [asking, setAsking] = useState<"discard" | "review">();
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; });
  if (!snap) return <aside aria-label="Build" className="flex flex-col gap-6 border-l border-border bg-card p-4"><Skeleton className="h-10" /><Skeleton className="h-9 w-1/2" /><Skeleton className="h-24" /></aside>;
  const dirty = dirtySpecs();
  const { job: running, verdict, waiting } = snap.session;
  const { jobs, check, manifest } = snap;
  /** The agent's, the sign-off's or the build's log, whichever ran last; the check reports in its own block. */
  const job = [jobs.agent, jobs.accept, jobs.build].filter((j): j is JobView => !!j).sort((a, b) => b.started - a.started)[0];
  const blocking = failing(check?.results);
  const review = snap.review.length;
  const copyPrompt = () => { navigator.clipboard.writeText(snap.prompt).then(() => toast("Sync prompt copied"), () => toast("Could not copy")); };

  return (
    <aside aria-label="Build" className="flex flex-col gap-6 overflow-auto border-l border-border bg-card p-4">
      <div aria-label="Where the project stands" className="relative grid grid-cols-5 before:absolute before:inset-x-[10%] before:top-2.75 before:h-0.5 before:bg-border">
        <Stage name="Edit" state={dirty.length ? "active" : "idle"} mark={dirty.length || ""} label={dirty.length ? `${dirty.length} specs changed` : "nothing unpublished"} />
        <Stage name="Publish" state={dirty.length ? "todo" : waiting ? "ok" : "idle"} mark="" label={dirty.length ? "waiting to publish" : waiting ? "published" : "nothing to publish"} />
        <Stage name="Sync" state={running === "Syncing" ? "running" : waiting ? "todo" : "ok"} mark={waiting || ""} label={waiting ? `${waiting} changes for the agent` : "in step"} />
        <Stage name="Check" state={running === "Checking" ? "running" : verdict === "Unknown" ? "idle" : verdict === "Failing" ? "bad" : "ok"} mark={blocking.length || ""}
          label={{ Unknown: "not checked since the specs changed", Failing: `${blocking.length} failing`, Reviewable: "only review left", Green: "all green" }[verdict]} />
        <Stage name="Sign off" state={running === "SigningOff" ? "running" : review ? "todo" : verdict === "Green" ? "ok" : "idle"} mark={review || ""} label={review ? `${review} to review` : "nothing to review"} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button title="⌘S" disabled={!can({ type: "publish", changes: 0 })} onClick={onPublish}><Icon name="check" />{dirty.length ? `Publish ${dirty.length}` : "Publish"}</Button>
        {can({ type: "discard" }) && <Button variant="outline" onClick={() => setAsking("discard")}>Discard</Button>}
        <Ask open={asking === "discard"} onOpenChange={() => setAsking(undefined)} title={`Discard changes to ${dirty.map((s) => s.file).join(", ")}`} action="Discard" onConfirm={discard} />
      </div>

      {manifest && (
        <div className="flex flex-col gap-2">
          <ul className="m-0 flex max-h-60 list-none flex-col gap-1 overflow-auto p-0 text-sm">
            {manifest.changes.map((c) => (
              <li key={`${c.action} ${c.kind} ${c.key}`} className="grid grid-cols-[14px_1fr] gap-1.5">
                <span aria-label={c.action} className={cn("font-mono font-semibold", c.action === "added" ? "text-ok" : c.action === "deleted" ? "text-destructive" : "text-warn")}>{SIGN[c.action]}</span>
                <span>{c.kind === "spec" ? c.key : c.key.replace(/^## /, "").replace(/^Story: /, "")}
                  {c.what.length > 0 && <div className="text-xs text-muted-foreground">{c.what.join(" · ")}</div>}</span>
              </li>
            ))}
          </ul>
          {manifest.regenerate.length > 0 && <div className="text-xs text-muted-foreground">↻ {manifest.regenerate.map((r) => r.gen).join(", ")}</div>}
          <div><Button variant="outline" size="sm" disabled={!can({ type: "markSynced" })} onClick={() => start("synced")}><Icon name="check" />Mark synced</Button></div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {snap.agents.map((a) => (
          <div key={a.id} className="flex items-center gap-2">
            <span className="flex-1 font-semibold">{a.label}</span>
            <Button variant="outline" size="sm" disabled={!a.available || !can({ type: "sync" })} title={a.available ? undefined : `${a.label} is not installed`} onClick={() => start("agent", { agent: a.id })}><Icon name="play" />Run</Button>
            {a.link && <Button variant="outline" size="sm" asChild><a href={a.link}><Icon name="open" />Open</a></Button>}
          </div>
        ))}
        <div><IconButton name="copy" label="Copy the sync prompt" onClick={copyPrompt} /></div>
      </div>

      {(snap.app.script || snap.app.buildable) && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Dot mark={snap.session.previewing ? "ok" : ""} label={snap.session.previewing ? "running" : "stopped"} />
            <span className="flex-1 font-semibold">App {snap.app.script && <span className="font-mono text-xs font-normal text-muted-foreground">pnpm {snap.app.script}</span>}</span>
            {snap.session.previewing && snap.app.url && <Button variant="outline" size="sm" asChild><a href={snap.app.url} target="_blank" rel="noreferrer"><Icon name="open" />Open</a></Button>}
            {snap.app.buildable && <Button variant="outline" size="sm" disabled={!can({ type: "build" })} onClick={() => start("build")}><Icon name="check" />Build</Button>}
            {snap.app.script && can({ type: "preview" }) && <Button variant="outline" size="sm" onClick={() => start("app", { start: true })}><Icon name="play" />Start</Button>}
            {can({ type: "endPreview" }) && <Button variant="outline" size="sm" onClick={() => start("app", { start: false })}><Icon name="stop" />Stop</Button>}
          </div>
          {snap.app.log.length > 0 && <Code className="max-h-40 whitespace-pre-wrap">{snap.app.log.slice(-40).join("\n")}</Code>}
        </div>
      )}

      {job && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border py-1.5 pr-2 pl-3 text-sm">
            <Dot mark={job.status === "running" ? "dirty" : job.status === "passed" ? "ok" : "bad"} label={job.status} />
            <span className="flex-1 font-semibold">{job.label}</span>
            <Elapsed job={job} />
            {job.status === "running" && can({ type: "stop" }) && <IconButton name="stop" label="Stop" onClick={() => start("stop")} />}
          </div>
          <pre ref={logRef} className="m-0 max-h-80 overflow-auto bg-muted px-3 py-2 font-mono text-xs leading-normal break-words whitespace-pre-wrap">{job.log.join("\n") || "…"}</pre>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {check && (
          <div className="flex items-start gap-2">
            <div className="flex-1"><Stages running={running === "Checking"} /></div>
            {jobs.check && <Elapsed job={jobs.check} />}
            {running === "Checking" && <IconButton name="stop" label="Stop" onClick={() => start("stop")} />}
          </div>
        )}
        {jobs.check?.status === "failed" && !check?.finished && (
          <details open className="text-xs"><summary className="cursor-pointer text-destructive">The check did not finish</summary><Code className="mt-1 max-h-65 whitespace-pre-wrap">{jobs.check.log.join("\n")}</Code></details>
        )}
        {check?.next && <div className="text-sm">{check.next}</div>}
        {blocking.map((r) => {
          const at = locate(r);
          // A failure about a rule or spec opens it, with what the check found under it (./Spec.tsx); any other shows it here.
          return at ? <Button key={`${r.stage} ${r.summary}`} variant="ghost" size="sm" className="h-auto justify-start py-1 text-left text-xs whitespace-normal text-destructive" onClick={() => reveal(at.file, at.key)}>{r.stage}: {r.summary}</Button>
            : <details key={`${r.stage} ${r.summary}`} className="text-xs"><summary className="cursor-pointer text-destructive">{r.stage}: {r.summary}</summary>{r.detail && <Code className="mt-1 max-h-65 whitespace-pre-wrap">{r.detail}</Code>}</details>;
        })}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={!can({ type: "check" })} onClick={() => start("check")}><Icon name="play" />Run check</Button>
          <Button variant="outline" size="sm" disabled={!review} onClick={() => setAsking("review")}><Icon name="check" />Review</Button>
          <ReviewDialog open={asking === "review"} onOpenChange={() => setAsking(undefined)} />
          {check?.finished !== undefined && <span className="text-xs text-muted-foreground">{new Date(check.finished).toLocaleTimeString()}</span>}
        </div>
      </div>
    </aside>
  );
}
