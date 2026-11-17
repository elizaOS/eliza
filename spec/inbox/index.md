# Inbox

The inbox package reads the owner's mailbox, keeps drafts recoverable,
and turns one reviewed draft into at most one provider request. Cached
reads never grant provider access. Background notices tell the owner
that mail arrived and open only the mail they were about. Managed
accounts reach the provider through the Cloud's
[managed Gmail](../cloud/index.md) route.

The linked cloud contracts are being rebuilt. Their detailed models and
execution evidence remain pending.

| Area | Specifications |
| --- | --- |
| Reading | [Mailbox reads and caches](./reads.md), [managed inbox read](./managedRead.md) |
| Writing | [Drafts and provider review](./drafts.md) |
| Notices | [Background notices](./backgroundNotices.md) |
