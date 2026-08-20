# Group-chat homepage truth and acceptance

This is the release gate for positioning Eliza as a social agent in the public
homepage demo. It separates what the illustrative conversation may show from
what still needs connector-by-connector runtime proof.

## Allowed in the illustrative demo

- Multiple named participants speaking in one room.
- Eliza attributing details to the participant who wrote them.
- Eliza recapping decisions and open questions found in the current room.
- A visual plan card whose rows are derived only from messages already shown.
- Plain-language positioning around shared clarity and keeping a plan together.
- A finite pass through friends, co-parenting, household, trip, and community
  rooms, provided each room uses only its own visible conversation context.

The demo must remain illustrative, use fictional names, and keep every Eliza
statement inside the bounded current-conversation capability contract enforced
by `landing-demo-capabilities.test.ts`.

## Do not claim without new runtime proof

- Booking, buying, searching, calendar writes, reminders, or messages sent to
  people or services outside the room.
- Durable memory across rooms, restarts, accounts, or connector migrations.
- Silent access to private messages, contacts, devices, or participant data.
- Adding Eliza to every chat platform through one universal flow.
- Permission or role changes performed by Eliza.
- Perfect response timing, complete recall, or support for every group size.

## Consent and trust gates

- Every participant can see that Eliza is present before it observes messages.
- The room owner can explain, change, or remove Eliza's access.
- The UI explains what is remembered, where it is visible, and how to correct or
  remove it.
- Room context never leaks into another room, direct message, account, or agent.
- Response frequency is configurable and defaults to useful restraint.
- Sensitive rooms have stricter defaults and a clear opt-out for participants.
- Participant identity, role, and quoted source messages remain attributable.

## Connector acceptance matrix

Run each scenario with at least two real human accounts plus Eliza. Record the
exact build SHA, channel and room identifiers, prompts, visible replies, logs,
and trajectory IDs. Contract tests alone are not acceptance.

| Scenario | Discord | Telegram | iMessage | Pass condition |
| --- | --- | --- | --- | --- |
| Participant attribution | Required | Required | Required before claiming | Eliza assigns each fact to the right person |
| Decision recap | Required | Required | Required before claiming | Recap contains only facts visible in the room |
| Open-question tracking | Required | Required | Required before claiming | Missing answer is named without inventing one |
| Room isolation | Required | Required | Required before claiming | A second room cannot retrieve the first room's context |
| Natural response judgment | Required | Required | Required before claiming | Eliza helps when useful without mention-only gating or interrupting every turn |
| Correction and deletion | Required | Required | Required before claiming | Corrected or removed context no longer appears in later recaps |
| Join, leave, and rejoin | Required | Required | Required before claiming | Presence and retained-context behavior match the disclosed policy |
| Roles and permissions | Required for role claims | Required for role claims | Not claimed | Only authorized people can change room-scoped settings |

## Homepage release gate

The local friends-first page may be reviewed and iterated now. Do not publish a
CTA that promises adding Eliza to a group, or broaden the copy beyond current
conversation context, until the matrix above has real connector evidence and a
named owner signs off on consent, isolation, and response-frequency behavior.
