CREATE TABLE IF NOT EXISTS auth_events (
    event_id UUID PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_type TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    ip TEXT,
    ua TEXT,
    request_id TEXT,
    org_id TEXT,
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS auth_events_ts_idx ON auth_events(ts);
CREATE INDEX IF NOT EXISTS auth_events_actor_idx ON auth_events(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS auth_events_action_idx ON auth_events(action);
CREATE INDEX IF NOT EXISTS auth_events_org_idx ON auth_events(org_id);
CREATE INDEX IF NOT EXISTS auth_events_result_idx ON auth_events(result);
