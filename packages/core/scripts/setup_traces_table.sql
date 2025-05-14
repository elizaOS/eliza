-- Create a dedicated database for instrumentation (optional)
-- CREATE DATABASE eliza_tracing;
-- \c eliza_tracing;

-- Create the traces table if it doesn't exist
CREATE TABLE IF NOT EXISTS traces (
    id SERIAL PRIMARY KEY,
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    trace_state TEXT,
    span_name TEXT NOT NULL,
    span_kind INTEGER,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    duration_ms INTEGER NOT NULL,
    status_code INTEGER,
    status_message TEXT,
    attributes JSONB,
    events JSONB,
    links JSONB,
    resource JSONB,
    agent_id TEXT,
    session_id TEXT,
    environment TEXT,
    room_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(trace_id, span_id)
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON traces(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_span_id ON traces(span_id);
CREATE INDEX IF NOT EXISTS idx_traces_parent_span_id ON traces(parent_span_id);
CREATE INDEX IF NOT EXISTS idx_traces_agent_id ON traces(agent_id);
CREATE INDEX IF NOT EXISTS idx_traces_session_id ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_room_id ON traces(room_id);
CREATE INDEX IF NOT EXISTS idx_traces_span_name ON traces(span_name);
CREATE INDEX IF NOT EXISTS idx_traces_start_time ON traces(start_time);
CREATE INDEX IF NOT EXISTS idx_traces_environment ON traces(environment);
