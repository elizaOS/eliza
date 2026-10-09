-- Existing Google write operations may have been registered before Gmail send
-- and Calendar insert were classified as consequential. Upgrade those rows and
-- bump their revision so every in-flight approval/commitment becomes stale.
UPDATE "provider_operations" AS operation
SET
  "risk_class" = 'consequential',
  "revision" = operation."revision" + 1,
  "updated_at" = now()
FROM "provider_accounts" AS account
WHERE operation."provider_account_id" = account."id"
  AND operation."tenant_id" = account."tenant_id"
  AND operation."workspace_id" = account."workspace_id"
  AND account."adapter_key" = 'google'
  AND operation."operation_key" IN (
    'google.gmail.messages.send',
    'google.calendar.events.insert'
  )
  AND operation."risk_class" <> 'consequential';
