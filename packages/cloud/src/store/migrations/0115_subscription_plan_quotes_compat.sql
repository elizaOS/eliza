DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'quotes' AND column_name = 'key'
  ) THEN
    IF EXISTS (SELECT 1 FROM subscription_commands WHERE status = 'quoted') THEN
      RAISE EXCEPTION 'unconfirmed legacy undo reviews need the retained quote layout';
    END IF;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM quotes q
    LEFT JOIN subscriptions s ON s.key = q.organization_id
    WHERE q.command_id IS NOT NULL
      AND (q.state->>'phase' IN ('Applied', 'Failed')) IS NOT TRUE
      AND (
        q.state->>'phase' IN ('Running', 'AwaitingPayment')
        AND q.state->>'commandId' = q.command_id
        AND q.state #>> '{receipt,providerKey,providerId}' = q.command_id
        AND q.state #>> '{receipt,session,owner,agentId}' = q.organization_id
        AND length(q.state #>> '{receipt,session,owner,actorId}') > 0
        AND s.live_command = q.command_id
        AND s.provider_subscription_id = q.state->>'subscriptionId'
        AND s.state->>'subscriptionId' = q.state->>'subscriptionId'
        AND s.state #>> '{liveCommand,tag}' = 'Live'
        AND s.state #>> '{liveCommand,commandId}' = q.command_id
        AND s.state #>> '{liveCommand,kind}' = q.state->>'kind'
        AND (
          (q.command_kind = 'upgrade' AND q.state->>'kind' = 'UpgradeCommand'
            AND q.state #>> '{receipt,providerKey,providerKind}' = 'SubscriptionUpdate'
            AND q.state #>> '{receipt,session,owner,connector}' = 'subscription_update')
          OR (q.command_kind = 'downgrade' AND q.state->>'kind' = 'DowngradeCommand'
            AND q.state #>> '{receipt,providerKey,providerKind}' = 'SubscriptionSchedule'
            AND q.state #>> '{receipt,session,owner,connector}' = 'subscription_schedule')
        )
      ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'a legacy plan command lacks its original subscription slot or provider binding';
  END IF;

  IF EXISTS (
    SELECT 1 FROM subscription_commands c
    WHERE c.status = 'quoted' AND (
      c.kind = 'undo' AND c.result_revision IS NULL
      AND c.key = 'rev_' || left(encode(sha256(convert_to(c.organization_id || chr(10) || 'UndoCommand', 'UTF8')), 'hex'), 32)
      AND c.expected_revision > 0 AND c.state->>'expectedRevision' = c.expected_revision::text
      AND c.state->>'phase' = 'Quoted' AND c.state->>'kind' = 'UndoCommand' AND c.state->>'commandId' = ''
      AND c.state #>> '{quote,quoteId}' ~ '^quo_[0-9a-f]{32}$'
      AND c.state #>> '{quote,targetPlanKey}' IN ('PlusMonthly', 'ProMonthly')
      AND ((c.state->'receipt') - 'session'::text) = '{
        "digest":"","providerKey":{"providerKind":"CheckoutSession","providerId":""},
        "staleAfter":0,"preparedAt":0,"claimedAt":0,"sentAt":0,"settledAt":0,
        "settlement":"Unsettled","refusal":"NoRefusal"
      }'::jsonb
      AND jsonb_typeof(c.state #> '{receipt,session,now}') = 'number'
      AND ((c.state #> '{receipt,session}') - 'now'::text) = '{
        "phase":"Absent","rowPresent":false,"owner":{"agentId":"","actorId":"","connector":""},
        "digest":"","claimSequence":0,"currentClaim":0,"invokedClaim":0,"leaseUntil":0,
        "expiresAt":0,"authorized":false,"effects":0,"executorAlive":false,"outcomeKnown":false
      }'::jsonb
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'a legacy quoted command has inconsistent review or provider evidence';
  END IF;

  ALTER TABLE quotes RENAME COLUMN key TO id;
  ALTER TABLE quotes
    ALTER COLUMN state DROP NOT NULL,
    ALTER COLUMN revision DROP NOT NULL,
    ALTER COLUMN created_at DROP NOT NULL,
    ALTER COLUMN updated_at DROP NOT NULL,
    DROP CONSTRAINT quotes_command_kind_check,
    ADD CONSTRAINT quotes_command_kind_check CHECK (command_kind IN ('upgrade', 'downgrade', 'undo'));

  WITH reviews AS (
    DELETE FROM subscription_commands WHERE status = 'quoted'
    RETURNING state, revision, organization_id, created_at, updated_at
  )
  INSERT INTO quotes (
    id, organization_id, command_kind, target_plan_key, proration_date, due_now_cents,
    recurring_cents, adjustment_micros, expires_at, state, revision, created_at, updated_at
  )
  SELECT state #>> '{quote,quoteId}', organization_id, 'undo',
    CASE state #>> '{quote,targetPlanKey}' WHEN 'PlusMonthly' THEN 'plus_monthly' ELSE 'pro_monthly' END,
    (state #>> '{quote,effectiveAt}')::bigint / 1000, (state #>> '{quote,dueNowCents}')::bigint,
    (state #>> '{quote,recurringCents}')::bigint, (state #>> '{quote,adjustment}')::bigint,
    (state #>> '{quote,expiresAt}')::bigint, state, revision, created_at, updated_at
  FROM reviews;
END;
$migration$;
