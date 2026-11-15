-- Extend the existing reviewed mailbox receipt kinds. Keep all prior receipts.
ALTER TABLE managed_gmail_operation_receipts
  DROP CONSTRAINT managed_gmail_operation_receipts_kind_check,
  ADD CONSTRAINT managed_gmail_operation_receipts_kind_check CHECK (
    kind IN ('send','draft-create','draft-replace','draft-delete','archive','unarchive','trash','untrash','mark-read','mark-unread','star','unstar')
  );
