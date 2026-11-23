// spec/nativePhone/index.md, "Story: Check calls and use the dialer without mistaking a handoff for a call"
import { Button, Input } from "@repo/ui"
import type { RecentCallsPage } from "@elizaos/os/bridges/definitions/phone"

export interface PhonePanelProps {
  readonly history: RecentCallsPage | undefined
  readonly pending: boolean
  readonly problem?: string
  readonly canOpenDialer: boolean
  readonly onDial: (number: string) => void
  readonly onNext: (cursor: NonNullable<RecentCallsPage["next"]>) => void
}

export function PhonePanel({ history, pending, problem, canOpenDialer, onDial, onNext }: PhonePanelProps) {
  return (
    <section aria-label="Phone" aria-busy={pending} className="grid gap-4">
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => {
        event.preventDefault()
        if (!canOpenDialer || pending) return
        const dialed = new FormData(event.currentTarget).get("number")
        if (typeof dialed === "string" && dialed.trim() !== "") onDial(dialed.trim())
      }}>
        <label className="grid gap-1">Phone number<Input name="number" type="tel" required disabled={!canOpenDialer || pending} /></label>
        <Button type="submit" disabled={!canOpenDialer || pending}>Open dialer</Button>
      </form>
      {problem && <p role="alert" className="text-destructive">{problem}</p>}
      {history?.calls.length === 0 && <p>No recent calls.</p>}
      {history && <ul className="grid gap-2">
        {history.calls.map((record) => <li key={record.id} className="flex items-center justify-between gap-3 border-b border-border pb-2">
          <span>{record.cachedName || record.number}</span>
          <span className="text-muted-foreground">{record.type}</span>
        </li>)}
      </ul>}
      {history?.next && <Button variant="outline" disabled={pending} onClick={() => {
        if (history.next !== null) onNext(history.next)
      }}>More calls</Button>}
    </section>
  )
}
