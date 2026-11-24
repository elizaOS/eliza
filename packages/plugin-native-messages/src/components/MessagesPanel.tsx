// spec/nativeMessages/index.md, "Story: Read my inbox and see the evidence for the message I reviewed"
import { Button, Input, Textarea } from "@repo/ui"
import type { ThreadPage, ThreadCursor, ThreadId } from "@elizaos/os/bridges/definitions/messages"

export interface MessagesPanelProps {
  readonly page: ThreadPage | undefined
  readonly pending: boolean
  readonly problem?: string
  readonly composeAllowed: boolean
  readonly onNext: (cursor: ThreadCursor) => void
  readonly onOpen: (threadId: ThreadId) => void
  readonly onCompose: (recipient: string, message: string) => void
}

export function MessagesPanel({ page, pending, problem, composeAllowed, onNext, onOpen, onCompose }: MessagesPanelProps) {
  return (
    <section aria-label="Messages" aria-busy={pending} className="grid gap-4">
      <form className="grid gap-2" onSubmit={(event) => {
        event.preventDefault()
        if (!composeAllowed || pending) return
        const form = new FormData(event.currentTarget)
        const recipient = form.get("recipient")
        const message = form.get("message")
        if (typeof recipient === "string" && typeof message === "string") onCompose(recipient.trim(), message)
      }}>
        <label className="grid gap-1">Recipient<Input name="recipient" type="tel" required disabled={!composeAllowed || pending} /></label>
        <label className="grid gap-1">Message<Textarea name="message" required disabled={!composeAllowed || pending} /></label>
        <Button type="submit" disabled={!composeAllowed || pending}>Review in Messages</Button>
      </form>
      {problem && <p role="alert" className="text-destructive">{problem}</p>}
      {page?.rows.length === 0 && <p>No conversations.</p>}
      {page && <ul className="grid gap-2">
        {page.rows.map((thread) => <li key={thread.id} className="border-b border-border pb-2">
          {"incomplete" in thread
            ? <span>Conversation details unavailable</span>
            : <Button variant="ghost" onClick={() => onOpen(thread.id)}>{thread.addresses.join(", ")}</Button>}
        </li>)}
      </ul>}
      {page?.next && <Button variant="outline" disabled={pending} onClick={() => {
        if (page.next !== null) onNext(page.next)
      }}>More conversations</Button>}
    </section>
  )
}
