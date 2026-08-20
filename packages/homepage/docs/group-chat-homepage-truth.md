# Group-chat homepage truth and acceptance

This is the release gate for positioning Eliza as a social agent in the public
homepage demo. It separates what the illustrative conversation may show from
what still needs connector-by-connector runtime proof.

## Allowed in the illustrative demo

- Multiple named participants speaking in one room.
- A distinct fictional cast and contact photo set for each room.
- Eliza attributing details to the participant who wrote them.
- Eliza recapping decisions and open questions found in the current room.
- A visual plan card whose rows are derived only from messages already shown.
- Plain-language positioning around shared clarity and keeping a plan together.
- A continuous rotation through friends, co-parenting, household, trip, and
  community rooms, provided each room resets cleanly and uses only its own
  visible conversation context.
- Four evolving recaps in each room, including a late constraint after the
  apparent decision, so the demo shows how Eliza keeps a plan coherent as the
  conversation changes instead of jumping straight to a terminal answer.
- A permissioned connected-capability moment when the card names its source:
  shared calendars, public web results, room-only memory, or personal reminders
  the speaking user has already allowed.
- Proactive assistance after ordinary human conversation. People should not
  need to narrate setup or prompt Eliza to compare, search, remember, or update
  an already-approved personal reminder.

The demo must remain illustrative, use fictional names, and keep every Eliza
statement inside the declared capability contract enforced by
`landing-demo-capabilities.test.ts`. Connected examples are illustrative and
must display their source or permission state; they are not a promise that a
fresh visitor has configured that integration.

Humor may come from adult coordination friction and Eliza's dry operational
clarity. A child, medical need, custody safety concern, or participant's private
data must never be the punchline.

## Do not claim without new runtime proof

- Booking, buying, calendar changes, or messages sent to people or services
  outside the room.
- Connected calendar reads, public web search, or scheduled reminders without
  the relevant connector or runtime being enabled and named in the UI.
- Durable memory across unrelated rooms, accounts, or connector migrations.
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
- Calendar availability is used only for participants who connected and shared
  it; the UI must never imply that one participant granted access for another.
- Long-term memory is scoped to the named room, begins with an explicit save,
  and stays inspectable, correctable, and removable.
- Reminder examples act only for the named person whose existing permission is
  shown in the source line. Eliza never creates or changes reminders for other
  participants unless each affected person separately opts in.
- Public web results show freshness and remain suggestions, not silent booking
  or purchasing actions.

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

The local friends-first page may be reviewed and iterated now. Its connected
cards are an explicitly sourced preview of runtime-backed capabilities, not
proof that every production channel exposes them. Do not publish a CTA that
promises adding Eliza to a group until the matrix above has real connector
evidence and a named owner signs off on consent, isolation, response-frequency,
and the exact connected-capability configuration shown on the page.
