"""Canonical SQLite schema for the unified trajectory database.

Provides DDL statements and index definitions.  The column names deliberately
match the production PostgreSQL schema so that queries and exports are portable.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Table DDL
# ---------------------------------------------------------------------------

CREATE_TRAJECTORIES = """\
CREATE TABLE IF NOT EXISTS trajectories (
    id                  TEXT PRIMARY KEY,
    trajectory_id       TEXT UNIQUE NOT NULL,
    agent_id            TEXT NOT NULL,
    source              TEXT,
    archetype           TEXT,
    window_id           TEXT,
    scenario_id         TEXT,
    batch_id            TEXT,
    episode_id          TEXT,
    status              TEXT DEFAULT 'active',
    start_time          REAL,
    end_time            REAL,
    duration_ms         INTEGER,
    total_reward            REAL DEFAULT 0.0,
    reward_components_json  TEXT,
    ai_judge_reward         REAL,
    ai_judge_reasoning      TEXT,
    final_status            TEXT,
    final_pnl           REAL,
    final_balance       REAL,
    episode_length      INTEGER DEFAULT 0,
    metrics_json        TEXT,
    metadata_json       TEXT,
    is_training_data    BOOLEAN DEFAULT 0,
    is_evaluation       BOOLEAN DEFAULT 0,
    used_in_training    BOOLEAN DEFAULT 0,
    created_at          TEXT,
    updated_at          TEXT
);
"""

CREATE_TRAJECTORY_STEPS = """\
CREATE TABLE IF NOT EXISTS trajectory_steps (
    id                      TEXT PRIMARY KEY,
    trajectory_id           TEXT NOT NULL,
    step_number             INTEGER NOT NULL,
    timestamp               REAL,
    observation_json        TEXT,
    action_type             TEXT,
    action_name             TEXT,
    action_params_json      TEXT,
    action_success          BOOLEAN,
    action_result_json      TEXT,
    reward                  REAL DEFAULT 0.0,
    done                    BOOLEAN DEFAULT 0,
    environment_state_json  TEXT,
    reasoning               TEXT,
    metadata_json           TEXT,
    UNIQUE(trajectory_id, step_number),
    FOREIGN KEY (trajectory_id) REFERENCES trajectories(trajectory_id)
);
"""

CREATE_LLM_CALLS = """\
CREATE TABLE IF NOT EXISTS llm_calls (
    id                  TEXT PRIMARY KEY,
    step_id             TEXT NOT NULL,
    trajectory_id       TEXT NOT NULL,
    call_index          INTEGER DEFAULT 0,
    timestamp           REAL,
    model               TEXT,
    system_prompt       TEXT,
    user_prompt         TEXT,
    messages_json       TEXT,
    response            TEXT,
    reasoning           TEXT,
    temperature         REAL,
    max_tokens          INTEGER,
    prompt_tokens       INTEGER,
    completion_tokens   INTEGER,
    latency_ms          REAL,
    purpose             TEXT,
    FOREIGN KEY (step_id)       REFERENCES trajectory_steps(id),
    FOREIGN KEY (trajectory_id) REFERENCES trajectories(trajectory_id)
);
"""

CREATE_PROVIDER_ACCESSES = """\
CREATE TABLE IF NOT EXISTS provider_accesses (
    id              TEXT PRIMARY KEY,
    step_id         TEXT NOT NULL,
    trajectory_id   TEXT NOT NULL,
    provider_name   TEXT,
    query_json      TEXT,
    response_json   TEXT,
    purpose         TEXT,
    timestamp       REAL,
    FOREIGN KEY (step_id)       REFERENCES trajectory_steps(id),
    FOREIGN KEY (trajectory_id) REFERENCES trajectories(trajectory_id)
);
"""

CREATE_CONTROL_FRAMES = """\
CREATE TABLE IF NOT EXISTS control_frames (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    trajectory_id           TEXT NOT NULL,
    planner_step_id         TEXT,
    timestamp               REAL NOT NULL,
    joint_positions_json    TEXT,
    joint_velocities_json   TEXT,
    joint_targets_json      TEXT,
    imu_roll                REAL,
    imu_pitch               REAL,
    gyro_json               TEXT,
    entity_slots_json       TEXT,
    action_applied_json     TEXT,
    reward                  REAL,
    FOREIGN KEY (trajectory_id)    REFERENCES trajectories(trajectory_id),
    FOREIGN KEY (planner_step_id)  REFERENCES trajectory_steps(id)
);
"""

CREATE_EMBODIED_CONTEXTS = """\
CREATE TABLE IF NOT EXISTS embodied_contexts (
    id                  TEXT PRIMARY KEY,
    trajectory_id       TEXT NOT NULL,
    step_id             TEXT,
    timestamp           REAL,
    entities_json       TEXT,
    camera_views_json   TEXT,
    agent_pose_json     TEXT,
    task_description    TEXT,
    source              TEXT,
    FOREIGN KEY (trajectory_id) REFERENCES trajectories(trajectory_id),
    FOREIGN KEY (step_id)       REFERENCES trajectory_steps(id)
);
"""

# ---------------------------------------------------------------------------
# All table creation statements in order
# ---------------------------------------------------------------------------

ALL_TABLE_DDL: list[str] = [
    CREATE_TRAJECTORIES,
    CREATE_TRAJECTORY_STEPS,
    CREATE_LLM_CALLS,
    CREATE_PROVIDER_ACCESSES,
    CREATE_CONTROL_FRAMES,
    CREATE_EMBODIED_CONTEXTS,
]

# ---------------------------------------------------------------------------
# Indexes
# ---------------------------------------------------------------------------

INDEX_DDL: list[str] = [
    # trajectories
    "CREATE INDEX IF NOT EXISTS idx_traj_agent ON trajectories(agent_id);",
    "CREATE INDEX IF NOT EXISTS idx_traj_source ON trajectories(source);",
    "CREATE INDEX IF NOT EXISTS idx_traj_archetype ON trajectories(archetype);",
    "CREATE INDEX IF NOT EXISTS idx_traj_status ON trajectories(status);",
    "CREATE INDEX IF NOT EXISTS idx_traj_training ON trajectories(is_training_data);",
    "CREATE INDEX IF NOT EXISTS idx_traj_reward ON trajectories(total_reward);",
    "CREATE INDEX IF NOT EXISTS idx_traj_created ON trajectories(created_at);",
    "CREATE INDEX IF NOT EXISTS idx_traj_batch ON trajectories(batch_id);",
    "CREATE INDEX IF NOT EXISTS idx_traj_scenario ON trajectories(scenario_id);",
    # trajectory_steps
    "CREATE INDEX IF NOT EXISTS idx_step_traj ON trajectory_steps(trajectory_id);",
    "CREATE INDEX IF NOT EXISTS idx_step_ts ON trajectory_steps(timestamp);",
    # llm_calls
    "CREATE INDEX IF NOT EXISTS idx_llm_step ON llm_calls(step_id);",
    "CREATE INDEX IF NOT EXISTS idx_llm_traj ON llm_calls(trajectory_id);",
    # provider_accesses
    "CREATE INDEX IF NOT EXISTS idx_prov_step ON provider_accesses(step_id);",
    "CREATE INDEX IF NOT EXISTS idx_prov_traj ON provider_accesses(trajectory_id);",
    # control_frames
    "CREATE INDEX IF NOT EXISTS idx_cf_traj ON control_frames(trajectory_id);",
    "CREATE INDEX IF NOT EXISTS idx_cf_ts ON control_frames(timestamp);",
    "CREATE INDEX IF NOT EXISTS idx_cf_planner ON control_frames(planner_step_id);",
    # embodied_contexts
    "CREATE INDEX IF NOT EXISTS idx_ec_traj ON embodied_contexts(trajectory_id);",
    "CREATE INDEX IF NOT EXISTS idx_ec_step ON embodied_contexts(step_id);",
]
