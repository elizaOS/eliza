CREATE TABLE IF NOT EXISTS phone_gateway_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,
    provider phone_provider NOT NULL,
    phone_number TEXT NOT NULL,
    bridge_id TEXT NOT NULL DEFAULT 'default',
    phone_account_id TEXT,
    phone_account_label TEXT,
    friendly_name TEXT,
    send_method TEXT,
    cloud_webhook_url TEXT,
    local_webhook_url TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    can_send_sms BOOLEAN NOT NULL DEFAULT true,
    can_receive_sms BOOLEAN NOT NULL DEFAULT true,
    can_send_imessage BOOLEAN NOT NULL DEFAULT true,
    can_receive_imessage BOOLEAN NOT NULL DEFAULT true,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS phone_gateway_devices_provider_phone_bridge_idx
    ON phone_gateway_devices(provider, phone_number, bridge_id);
CREATE INDEX IF NOT EXISTS phone_gateway_devices_organization_idx
    ON phone_gateway_devices(organization_id);
CREATE INDEX IF NOT EXISTS phone_gateway_devices_phone_number_idx
    ON phone_gateway_devices(phone_number);
CREATE INDEX IF NOT EXISTS phone_gateway_devices_is_active_idx
    ON phone_gateway_devices(is_active);

