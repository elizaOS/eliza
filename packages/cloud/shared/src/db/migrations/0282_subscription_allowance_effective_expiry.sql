ALTER TABLE subscription_allowance_periods
  DROP CONSTRAINT subscription_allowance_periods_period_check;
--> statement-breakpoint
ALTER TABLE subscription_allowance_periods
  ADD CONSTRAINT subscription_allowance_periods_period_check CHECK (
    period_end > period_start
    AND expires_at > period_start
    AND expires_at <= period_end
  );
