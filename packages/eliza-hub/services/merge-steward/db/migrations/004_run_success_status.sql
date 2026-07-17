-- Match the steward runtime, which records completed queue runs as succeeded.

BEGIN;

ALTER TABLE steward_runs
  DROP CONSTRAINT IF EXISTS steward_runs_status_check;

ALTER TABLE steward_runs
  ADD CONSTRAINT steward_runs_status_check CHECK (
    status IN (
      'running',
      'waiting_approval',
      'waiting_event',
      'waiting_timer',
      'paused',
      'recovering',
      'finished',
      'succeeded',
      'failed',
      'cancelled'
    )
  );

COMMIT;
