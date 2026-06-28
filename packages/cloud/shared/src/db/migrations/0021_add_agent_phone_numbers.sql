-- Migration: Add agent_phone_numbers and phone_message_log tables
-- These tables map phone numbers to agents and track message history

-- Create phone provider enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'phone_provider') THEN
        CREATE TYPE phone_provider AS ENUM ('twilio', 'blooio', 'vonage', 'other');
    END IF;
END$$;

-- Create phone type enum
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'phone_type') THEN
        CREATE TYPE phone_type AS ENUM ('sms', 'voice', 'both', 'imessage');
    END IF;
END$$;

-- Create agent_phone_numbers table
CREATE TABLE IF NOT EXISTS agent_phone_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Organization owner
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Agent to route messages to
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    
    -- Phone number details
    phone_number TEXT NOT NULL,
    friendly_name TEXT,
    
    -- Provider information
    provider phone_provider NOT NULL,
    phone_type phone_type NOT NULL DEFAULT 'sms',
    
    -- Provider-specific ID
    provider_phone_id TEXT,
    
    -- Webhook configuration
    webhook_url TEXT,
    webhook_configured BOOLEAN NOT NULL DEFAULT false,
    
    -- Status
    is_active BOOLEAN NOT NULL DEFAULT true,
    verified BOOLEAN NOT NULL DEFAULT false,
    verified_at TIMESTAMP,
    
    -- Capabilities
    can_send_sms BOOLEAN NOT NULL DEFAULT true,
    can_receive_sms BOOLEAN NOT NULL DEFAULT true,
    can_send_mms BOOLEAN NOT NULL DEFAULT false,
    can_receive_mms BOOLEAN NOT NULL DEFAULT false,
    can_voice BOOLEAN NOT NULL DEFAULT false,
    
    -- Rate limiting
    max_messages_per_minute TEXT DEFAULT '60',
    max_messages_per_day TEXT DEFAULT '1000',
    
    -- Metadata
    metadata TEXT DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMP
);

-- Create indexes for agent_phone_numbers
CREATE UNIQUE INDEX IF NOT EXISTS agent_phone_numbers_phone_org_idx 
    ON agent_phone_numbers(phone_number, organization_id);
CREATE INDEX IF NOT EXISTS agent_phone_numbers_organization_idx 
    ON agent_phone_numbers(organization_id);
CREATE INDEX IF NOT EXISTS agent_phone_numbers_agent_idx 
    ON agent_phone_numbers(agent_id);
CREATE INDEX IF NOT EXISTS agent_phone_numbers_provider_idx 
    ON agent_phone_numbers(provider);
CREATE INDEX IF NOT EXISTS agent_phone_numbers_is_active_idx 
    ON agent_phone_numbers(is_active);

-- Create phone_message_log table
CREATE TABLE IF NOT EXISTS phone_message_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Link to phone number mapping
    phone_number_id UUID NOT NULL REFERENCES agent_phone_numbers(id) ON DELETE CASCADE,
    
    -- Message details
    direction TEXT NOT NULL,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    message_body TEXT,
    message_type TEXT NOT NULL DEFAULT 'sms',
    
    -- Media attachments (for MMS)
    media_urls TEXT,
    
    -- Provider message ID
    provider_message_id TEXT,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'received',
    error_message TEXT,
    
    -- Agent response
    agent_response TEXT,
    response_time_ms TEXT,
    
    -- Metadata
    metadata TEXT DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMP
);

-- Create indexes for phone_message_log
CREATE INDEX IF NOT EXISTS phone_message_log_phone_number_idx 
    ON phone_message_log(phone_number_id);
CREATE INDEX IF NOT EXISTS phone_message_log_direction_idx 
    ON phone_message_log(direction);
CREATE INDEX IF NOT EXISTS phone_message_log_status_idx 
    ON phone_message_log(status);
CREATE INDEX IF NOT EXISTS phone_message_log_created_at_idx 
    ON phone_message_log(created_at);
CREATE INDEX IF NOT EXISTS phone_message_log_from_number_idx
    ON phone_message_log(from_number);
CREATE INDEX IF NOT EXISTS phone_message_log_provider_msg_idx
    ON phone_message_log(provider_message_id);
