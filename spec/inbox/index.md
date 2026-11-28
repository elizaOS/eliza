# Inbox

The inbox package reads the owner's mailbox, keeps drafts recoverable,
and turns one reviewed draft into at most one provider request. Cached
reads never grant provider access. Background notices tell the owner
that mail arrived and open only the mail they were about. Managed
accounts reach the provider through the Cloud's
managed Gmail [read](../cloud/index.md#an-approved-connection-grants-the-owner-only-the-selected-reads) and
[operations](../cloud/index.md#managed-mail-dispatch-requires-separate-consent-and-explicit-approval) routes.

| Area | Specifications |
| --- | --- |
| Access | [Incremental Gmail grants](./grants.md), [mail failures and disconnect](./failures.md) |
| Reading | [Mailbox reads and caches](./reads.md), [managed inbox read](./managedRead.md), [read state](./readState.md), [inert display](./display.md) |
| Writing | [Drafts and provider review](./drafts.md), [outgoing mail and its review](./outgoing.md), [hand-offs with the agent](./handoff.md) |
| Notices | [Background notices](./backgroundNotices.md) |
| Triage | [Unified cross-channel triage and subscriptions](./triage.md) |
