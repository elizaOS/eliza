-- Snapshot identities and values are database-derived; live profile/provider data is hashed, never copied into retained evidence.
CREATE OR REPLACE FUNCTION app_billing_completion_commands(p_request uuid) RETURNS TABLE(command_id uuid) LANGUAGE sql STABLE AS $$
  WITH r AS (SELECT * FROM account_deletion_requests WHERE id=p_request), scopes AS (
    SELECT s.id FROM app_billing_scopes s JOIN app_billing_deletion_completion_accounts(p_request) a ON a.account_id=s.billing_account_id
  )
  SELECT c.id FROM billing_subscription_commands c CROSS JOIN r WHERE c.organization_id=r.organization_id OR c.requested_by_user_id=r.user_id OR c.request_payload->>'requestId'=r.id::text
    OR c.billing_scope_id IN(SELECT id FROM scopes) OR c.request_payload->'source'->'scope'->>'scopeId' IN(SELECT id::text FROM scopes)
    OR c.request_payload->'source'->>'paidPeriodId' IN(SELECT id::text FROM app_subscription_paid_periods WHERE billing_scope_id IN(SELECT id FROM scopes))
    OR c.id IN(SELECT command_id FROM app_billing_deletion_refund_inventory(p_request));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_billing_completion_inventory(p_request uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  WITH request AS (SELECT * FROM account_deletion_requests WHERE id=p_request),
  accounts AS (SELECT account_id FROM app_billing_deletion_completion_accounts(p_request)),
  applications AS (SELECT x.* FROM apps x JOIN app_billing_deletion_completion_apps(p_request) a ON a.app_id=x.id),
  scopes AS (SELECT s.* FROM app_billing_scopes s JOIN accounts a ON a.account_id=s.billing_account_id),
  commands AS (SELECT c.* FROM billing_subscription_commands c JOIN app_billing_completion_commands(p_request) i ON i.command_id=c.id),
  subscriptions AS (SELECT s.* FROM billing_subscriptions s WHERE s.billing_scope_id IN(SELECT id FROM scopes) OR s.organization_id IN(SELECT organization_id FROM request) OR s.id IN(SELECT result_subscription_id FROM commands)),
  inventory AS (
    SELECT 'account_deletion_requests' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM account_deletion_requests t WHERE t.id=p_request
    UNION ALL
    SELECT 'organizations' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM organizations t WHERE t.id IN(SELECT organization_id FROM applications UNION SELECT organization_id FROM request UNION SELECT organization_id FROM commands)
    UNION ALL
    SELECT 'apps' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM apps t WHERE t.id IN(SELECT id FROM applications)
    UNION ALL
    SELECT 'app_billing_accounts' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_accounts t WHERE t.id IN(SELECT account_id FROM accounts)
    UNION ALL
    SELECT 'app_billing_scopes' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_scopes t WHERE t.id IN(SELECT id FROM scopes)
    UNION ALL
    SELECT 'app_billing_customers' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_customers t WHERE t.billing_account_id IN(SELECT account_id FROM accounts)
    UNION ALL
    SELECT 'app_billing_members' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_members t WHERE t.billing_account_id IN(SELECT account_id FROM accounts)
    UNION ALL
    SELECT 'users' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM users t WHERE t.id IN(SELECT user_id FROM request UNION SELECT user_id FROM app_billing_members WHERE billing_account_id IN(SELECT account_id FROM accounts) AND role='administrator')
    UNION ALL
    SELECT 'billing_merchants' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_merchants t WHERE t.id IN(SELECT merchant_id FROM scopes UNION SELECT merchant_id FROM commands) OR t.organization_id IN(SELECT organization_id FROM request)
    UNION ALL
    SELECT 'app_billing_plan_revisions' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_plan_revisions t WHERE t.app_id IN(SELECT id FROM applications)
    UNION ALL
    SELECT 'billing_subscriptions' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_subscriptions t WHERE t.id IN(SELECT id FROM subscriptions)
    UNION ALL
    SELECT 'billing_subscription_revisions' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_subscription_revisions t WHERE t.subscription_id IN(SELECT id FROM subscriptions)
    UNION ALL
    SELECT 'billing_subscription_commands' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_subscription_commands t WHERE t.id IN(SELECT id FROM commands)
    UNION ALL
    SELECT 'billing_funding_reservations' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_funding_reservations t WHERE t.billing_scope_id IN(SELECT id FROM scopes) OR t.organization_id IN(SELECT organization_id FROM request)
    UNION ALL
    SELECT 'app_subscription_trials' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_subscription_trials t WHERE t.billing_scope_id IN(SELECT id FROM scopes)
    UNION ALL
    SELECT 'app_subscription_paid_periods' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_subscription_paid_periods t WHERE t.billing_scope_id IN(SELECT id FROM scopes)
    UNION ALL
    SELECT 'app_billing_deletion_dispositions' AS relation,t.request_id::text||':'||t.scope_id::text::text AS identity,to_jsonb(t) AS value FROM app_billing_deletion_dispositions t WHERE t.request_id=p_request OR t.scope_id IN(SELECT id FROM scopes)
    UNION ALL
    SELECT 'app_billing_customer_closures' AS relation,t.customer_binding_id::text AS identity,to_jsonb(t) AS value FROM app_billing_customer_closures t WHERE t.initiating_request_id=p_request OR t.billing_account_id IN(SELECT account_id FROM accounts)
    UNION ALL
    SELECT 'app_billing_refund_observations' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_refund_observations t WHERE t.request_id=p_request OR t.command_id IN(SELECT id FROM commands)
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('relation',relation,'identity',identity,'value',value) ORDER BY relation,identity),'[]'::jsonb) FROM inventory;
$$;
