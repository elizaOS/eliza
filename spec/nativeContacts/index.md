# Native contacts

The [Android contacts catalog](../os/android/contacts.md) owns provider paging, receipts, and device policy. The bridge serves the local Contacts view and exposes a read/create capability.

## Story: Read or add contacts only within my device permissions

> As the owner, I want complete bounded contact pages and a distinction between read and write permission.

### A contacts read needs a read grant and a write needs a write grant

The contacts catalog hands over a provider-controlled continuation.

```quint
type ContactCapability = BrowseContacts | CreateNativeContact
type ContactGrant = { readable: bool, writable: bool }
type ContactPage = { maxRows: int, returnedRows: int, hasContinuation: bool }
pure def mayUseContacts(grant: ContactGrant, op: ContactCapability): bool =
  if (op == BrowseContacts) grant.readable else grant.writable
pure def validContactsPage(page: ContactPage): bool =
  page.maxRows > 0 and page.returnedRows >= 0 and page.returnedRows <= page.maxRows and
  (page.hasContinuation implies page.returnedRows > 0)
pure def lawBrowseNeverNeedsWrite(grant: ContactGrant): bool =
  mayUseContacts(grant, BrowseContacts) == grant.readable
pure def lawContactsWriteNeedsWriteGrant(grant: ContactGrant, op: ContactCapability): bool =
  (op != BrowseContacts and mayUseContacts(grant, op)) implies grant.writable
pure val grantValues = Set(
  { readable: true, writable: false },
  { readable: false, writable: true },
  { readable: false, writable: false })
```
