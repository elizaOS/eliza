-- Fence the retired hosted WhatsApp credential namespace before deleting its
-- encrypted rows. Cloud migrations run before the new Worker deploy, so the
-- trigger prevents the previous release from recreating credentials during
-- that cutover window.
CREATE OR REPLACE FUNCTION reject_retired_hosted_whatsapp_secret()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope = 'organization'
    AND NEW.project_id IS NULL
    AND NEW.environment IS NULL
    AND NEW.name IN (
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_BUSINESS_PHONE'
  ) THEN
    RAISE EXCEPTION 'hosted WhatsApp credentials are retired'
      USING ERRCODE = '23514', CONSTRAINT = 'secrets_hosted_whatsapp_retired';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS secrets_reject_retired_hosted_whatsapp ON secrets;
--> statement-breakpoint
CREATE TRIGGER secrets_reject_retired_hosted_whatsapp
BEFORE INSERT OR UPDATE OF name ON secrets
FOR EACH ROW EXECUTE FUNCTION reject_retired_hosted_whatsapp_secret();
--> statement-breakpoint
INSERT INTO secret_audit_log (
  secret_id,
  organization_id,
  action,
  secret_name,
  actor_type,
  actor_id,
  source,
  metadata
)
SELECT
  id,
  organization_id,
  'deleted'::secret_audit_action,
  name,
  'system'::secret_actor_type,
  'migration:0299',
  'hosted-whatsapp-cutover',
  '{"reason":"hosted_connector_retired"}'::jsonb
FROM secrets
WHERE name IN (
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_BUSINESS_PHONE'
)
AND scope = 'organization'
AND project_id IS NULL
AND environment IS NULL;
--> statement-breakpoint
DELETE FROM secrets
WHERE name IN (
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_BUSINESS_PHONE'
)
AND scope = 'organization'
AND project_id IS NULL
AND environment IS NULL;
