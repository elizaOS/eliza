-- Add server_agents association table
CREATE TABLE IF NOT EXISTS server_agents (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    PRIMARY KEY (server_id, agent_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_server_agents_server_id ON server_agents(server_id);
CREATE INDEX IF NOT EXISTS idx_server_agents_agent_id ON server_agents(agent_id); 