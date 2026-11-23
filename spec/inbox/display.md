# Showing mail as inert text

Mail is shown as text. Links found in it are data that is never fetched
or rendered as HTML, and the next page of a list may be read ahead once,
in memory only. [Mailbox reads](./reads.md) own the pages and caches this
reads ahead into.

## Story: Read mail without its links or pages acting on their own

> As the owner, I want links in mail to be plain and honest about where
> they go, and paging to feel quick without the phone polling Gmail.

### Only an absolute web link without credentials is kept, and its shown text is plain

A link is kept only when it parses as an absolute `https` or `http` URL of
at most 2,048 characters with a host and no user name or password. Its text
has control characters replaced, runs of space collapsed and is at most 200
characters, or is the host when empty. Plain-text `https` URLs in a body
become at most 50 distinct links, trimmed of trailing punctuation except a
closing bracket that closes one in the URL; a body with more says how many
further distinct links it left out, so none is dropped unannounced. A link
whose text names a different site than its destination is marked.

```quint
type LinkFacts = { units: int, absolute: bool, webScheme: bool, hasHost: bool, hasCredentials: bool }
pure def linkKept(facts: LinkFacts): bool =
  facts.units <= 2048 and facts.absolute and facts.webScheme and facts.hasHost and not(facts.hasCredentials)
pure def textMismatch(namesHost: bool, sameSite: bool): bool = namesHost and not(sameSite)
pure val okLink: LinkFacts = { units: 20, absolute: true, webScheme: true, hasHost: true, hasCredentials: false }
pure val factsValues = Set(okLink, { ...okLink, webScheme: false }, { ...okLink, hasCredentials: true }, { ...okLink, units: 2049 })
pure val linkMaximum: int = 50
pure def linksShown(found: int): int = if (found > linkMaximum) linkMaximum else found
pure def linksOmitted(found: int): int = if (found > linkMaximum) found - linkMaximum else 0
pure val foundValues = Set(0, 1, 50, 51, 120)
pure def lawEveryLinkIsShownOrCounted(found: int): bool = found >= 0 implies linksShown(found) + linksOmitted(found) == found
pure def lawCredentialLinksAreDropped(facts: LinkFacts): bool = facts.hasCredentials implies not(linkKept(facts))
pure def lawOnlyWebLinksAreKept(facts: LinkFacts): bool = linkKept(facts) implies facts.webScheme and facts.absolute
```

### A preview is text: each character reference is decoded once and padding is collapsed

Gmail writes a snippet with HTML character references. A preview shows it
as text: a numeric reference and the references `amp`, `lt`, `gt`, `quot`,
`apos` and `nbsp` become their character, each once, so `&amp;amp;` shows
`&amp;`; any other named reference stays as written. A numeric reference
that is zero, past the last Unicode code point or a surrogate becomes
U+FFFD. A run of three or more spaces and invisible padding characters
becomes one space, and the preview is trimmed. The agent's
[inbox read](./managedRead.md) hands the planner a message's subject and
snippet as this text, never as Gmail escaped it.

```quint
pure val lastCodePoint: int = 1114111
pure def referenceDecodes(code: int): bool = code >= 1 and code <= lastCodePoint and not(code >= 55296 and code <= 57343)
pure val codeValues = Set(0, 38, 55295, 55296, 57343, 57344, 1114111, 1114112)
pure def lawASurrogateOrOutOfRangeReferenceIsNotDecoded(code: int): bool =
  (code < 1 or code > lastCodePoint or (code >= 55296 and code <= 57343)) implies not(referenceDecodes(code))
```

### A page is read ahead once at a time, kept briefly, and never retried

At most one speculative read of a next page runs at a time; preparing
another cancels it. A finished page is kept for thirty seconds, for at most
eight lists, and taken once; an expired or cancelled page is read again only
when the owner pages. Nothing polls and nothing retries on its own.

```quint
type AheadSlot = { pending: int, ready: int }
pure val aheadTtlMs: int = 30000
pure val aheadLists: int = 8
pure def aheadUsable(readAt: int, now: int): bool = readAt <= now and now - readAt < aheadTtlMs
pure def aheadAdmit(slot: AheadSlot): AheadSlot =
  { pending: 0, ready: if (slot.ready + 1 > aheadLists) aheadLists else slot.ready + 1 }
pure val slotValues = Set({ pending: 0, ready: 0 }, { pending: 1, ready: 8 }, { pending: 1, ready: 3 })
pure val readAtValues = Set(0, 1000, 30000)
pure val nowValues = Set(0, 29999, 30000, 31000)
pure def lawAheadStaysBounded(slot: AheadSlot): bool =
  slot.ready >= 0 and slot.ready <= aheadLists implies aheadAdmit(slot).ready <= aheadLists and aheadAdmit(slot).pending == 0
pure def lawExpiredPageIsNotUsed(readAt: int, now: int): bool = now - readAt >= aheadTtlMs implies not(aheadUsable(readAt, now))
```
