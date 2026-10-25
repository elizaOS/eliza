-- Managed Inbox read-state effects: reviewed mark-read/mark-unread receipts.
-- Additive: widens the kind allowlist only; existing receipts are preserved.
ALTER TABLE managed_gmail_operation_receipts
  DROP CONSTRAINT managed_gmail_operation_receipts_kind_check,
  ADD CONSTRAINT managed_gmail_operation_receipts_kind_check CHECK (
    kind IN ('send','draft-create','draft-replace','draft-delete','archive','unarchive','trash','untrash','mark-read','mark-unread')
  );
