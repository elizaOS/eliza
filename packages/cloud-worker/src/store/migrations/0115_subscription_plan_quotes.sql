ALTER TABLE quotes
  ADD COLUMN reviewer_user_id text REFERENCES accounts (key),
  ADD COLUMN reviewed_command jsonb,
  ADD COLUMN stripe_plan_binding jsonb,
  ADD CONSTRAINT quotes_review_is_complete CHECK (
    (reviewer_user_id IS NULL AND reviewed_command IS NULL AND stripe_plan_binding IS NULL)
    OR (reviewer_user_id IS NOT NULL AND reviewed_command IS NOT NULL AND stripe_plan_binding IS NOT NULL
        AND jsonb_typeof(reviewed_command) = 'object' AND (reviewed_command->>'phase') IS NOT DISTINCT FROM 'Quoted'
        AND jsonb_typeof(stripe_plan_binding) = 'object')
  );

CREATE UNIQUE INDEX quotes_current_review ON quotes (organization_id) WHERE reviewer_user_id IS NOT NULL;
