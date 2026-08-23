-- Retire persisted BlueBubbles bridge rows without deleting their audit history.
UPDATE "phone_gateway_devices"
SET
  "is_active" = FALSE,
  "can_send_sms" = FALSE,
  "can_receive_sms" = FALSE,
  "can_send_imessage" = FALSE,
  "can_receive_imessage" = FALSE,
  "updated_at" = NOW()
WHERE
  LOWER(BTRIM(COALESCE("send_method", ''))) = 'bluebubbles-local-bridge'
  OR LOWER(BTRIM(COALESCE("metadata" ->> 'gatewayKind', ''))) = 'bluebubbles';
