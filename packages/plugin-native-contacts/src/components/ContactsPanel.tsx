// spec/nativeContacts/index.md, "Story: Read or add contacts only within my device permissions"
import { Button, Input } from "@repo/ui"
import type { AddressBookPage, ContactCursor, ContactId } from "@elizaos/os/bridges/definitions/contacts"

export interface ContactsPanelProps {
  readonly page: AddressBookPage | undefined
  readonly problem?: string
  readonly pending: boolean
  readonly canAdd: boolean
  readonly onSearch: (query: string) => void
  readonly onNext: (cursor: ContactCursor) => void
  readonly onOpen: (id: ContactId) => void
  readonly onAdd: () => void
}

export function ContactsPanel({ page, problem, pending, canAdd, onSearch, onNext, onOpen, onAdd }: ContactsPanelProps) {
  return (
    <section aria-label="Contacts" aria-busy={pending} className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <form className="flex items-end gap-3" onSubmit={(event) => {
          event.preventDefault()
          const query = new FormData(event.currentTarget).get("query")
          if (typeof query === "string") onSearch(query.trim())
        }}>
          <label className="grid gap-1">Search contacts<Input type="search" name="query" disabled={pending} /></label>
          <Button type="submit" disabled={pending}>Search</Button>
        </form>
        <Button variant="outline" disabled={!canAdd || pending} onClick={onAdd}>Add contact</Button>
      </div>
      {problem && <p role="alert" className="text-destructive">{problem}</p>}
      {page?.contacts.length === 0 && <p>No contacts found.</p>}
      {page && <ul className="grid gap-2">
        {page.contacts.map((contact) => <li key={contact.id} className="border-b border-border pb-2">
          {"incomplete" in contact
            ? <span>Contact details unavailable</span>
            : <Button variant="ghost" onClick={() => onOpen(contact.id)}>{contact.name}</Button>}
        </li>)}
      </ul>}
      {page?.next && <Button variant="outline" disabled={pending} onClick={() => {
        if (page.next !== null) onNext(page.next)
      }}>More contacts</Button>}
    </section>
  )
}
