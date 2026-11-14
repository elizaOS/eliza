# Saved reminder presentation authority

Source `types/reminder-presentation.ts` retains exact frozen presentation objects in a process-global WeakSet shared across module copies. Serialized or reconstructed objects with equal text have no authority. `security/voice-gate.ts` additionally checks that supplied content text equals the issued chat text.

## Story: Carry an exact saved reminder to its delivery

As a reminder owner, I want transport rendering to recognize only the presentation object I issued for the saved reminder.

### Issuance requires a nonblank body and title and a chat text beginning with the body

The constructor preserves original strings, freezes the object and records its identity. Read accepts only that issued identity. Empty trimmed body/title or mismatched chat text throws `REMINDER_PRESENTATION_INVALID`. The model's prefix witness comes from the source string-prefix operation.

```quint
type ReminderPresentation = { identity: str, body: str, chatText: str, title: str }
type ReminderAuthority = { issued: List[ReminderPresentation] }
pure val initial: ReminderAuthority = { issued: List() }
pure def canIssue(s: ReminderAuthority, identity: str, bodyPresent: bool, titlePresent: bool, startsWithBody: bool): bool = identity != "" and not(s.issued.some(presentation => presentation.identity == identity)) and bodyPresent and titlePresent and startsWithBody
pure def issue(s: ReminderAuthority, identity: str, body: str, chatText: str, title: str, bodyPresent: bool, titlePresent: bool, startsWithBody: bool): ReminderAuthority = { issued: s.issued.append({ identity: identity, body: body, chatText: chatText, title: title }) }
pure def presentationTrusted(s: ReminderAuthority, identity: str): bool = s.issued.some(presentation => presentation.identity == identity)
pure def presentationMatches(s: ReminderAuthority, identity: str, chatText: str): bool = s.issued.some(presentation => presentation.identity == identity and presentation.chatText == chatText)
pure def alwaysIssuedIdentityUnique(s: ReminderAuthority): bool = s.issued.every(presentation => s.issued.select(other => other.identity == presentation.identity).length() == 1)
pure def stepPresentationsStayFrozen(before: ReminderAuthority, after: ReminderAuthority): bool = before.issued.every(presentation => after.issued.includes(presentation))
pure def sometimesTrustedReminder(s: ReminderAuthority): bool = s.issued.length() > 0
```
