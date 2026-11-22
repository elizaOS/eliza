ALTER TABLE quotes ADD COLUMN stripe_schedule_binding jsonb;

ALTER TABLE subscription_commands
  ADD COLUMN stripe_schedule_binding jsonb,
  ADD COLUMN stripe_schedule_attach_origin jsonb,
  ADD COLUMN stripe_schedule_configure_origin jsonb,
  ADD COLUMN quote_confirmation_digest text;

UPDATE quotes
SET reviewed_command = reviewed_command || jsonb_build_object(
  'schedule', jsonb_build_object(
    'tag', CASE WHEN command_kind = 'downgrade' THEN 'ScheduleReviewPending' ELSE 'NoScheduleWork' END
  )
)
WHERE reviewer_user_id IS NOT NULL AND reviewed_command IS NOT NULL AND NOT (reviewed_command ? 'schedule');

UPDATE subscription_commands
SET state = state || '{"schedule":{"tag":"NoScheduleWork"}}'::jsonb
WHERE kind='upgrade' AND stripe_plan_binding IS NOT NULL AND NOT (state ? 'schedule');
