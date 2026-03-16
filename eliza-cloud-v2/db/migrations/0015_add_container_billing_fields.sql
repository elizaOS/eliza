-- Migration: Add container billing tracking fields
-- Enables daily billing for containers with shutdown warnings

-- Add billing tracking columns to containers table
ALTER TABLE containers
ADD COLUMN IF NOT EXISTS last_billed_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS next_billing_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS billing_status TEXT DEFAULT 'active' NOT NULL,
ADD COLUMN IF NOT EXISTS shutdown_warning_sent_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS scheduled_shutdown_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS total_billed NUMERIC(10, 2) DEFAULT '0.00' NOT NULL;

-- Add index for billing queries
CREATE INDEX IF NOT EXISTS containers_billing_status_idx ON containers(billing_status);
CREATE INDEX IF NOT EXISTS containers_next_billing_idx ON containers(next_billing_at);
CREATE INDEX IF NOT EXISTS containers_scheduled_shutdown_idx ON containers(scheduled_shutdown_at);

-- Add billing history table for audit trail
CREATE TABLE IF NOT EXISTS container_billing_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id UUID NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL,
  billing_period_start TIMESTAMP NOT NULL,
  billing_period_end TIMESTAMP NOT NULL,
  status TEXT DEFAULT 'success' NOT NULL, -- 'success', 'failed', 'insufficient_credits'
  credit_transaction_id UUID REFERENCES credit_transactions(id) ON DELETE SET NULL,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Indexes for billing records
CREATE INDEX IF NOT EXISTS container_billing_records_container_idx ON container_billing_records(container_id);
CREATE INDEX IF NOT EXISTS container_billing_records_org_idx ON container_billing_records(organization_id);
CREATE INDEX IF NOT EXISTS container_billing_records_created_idx ON container_billing_records(created_at);
CREATE INDEX IF NOT EXISTS container_billing_records_status_idx ON container_billing_records(status);

-- Comment on columns for documentation
COMMENT ON COLUMN containers.last_billed_at IS 'Last time this container was charged for daily billing';
COMMENT ON COLUMN containers.next_billing_at IS 'Next scheduled billing time for this container';
COMMENT ON COLUMN containers.billing_status IS 'Billing status: active, warning, suspended, shutdown_pending';
COMMENT ON COLUMN containers.shutdown_warning_sent_at IS 'When the 48-hour shutdown warning email was sent';
COMMENT ON COLUMN containers.scheduled_shutdown_at IS 'When container is scheduled to be shut down due to insufficient credits';
COMMENT ON COLUMN containers.total_billed IS 'Total amount billed for this container lifetime';
