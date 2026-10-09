-- Additive: preserve every existing approval, execution receipt and owner binding.
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "device_read_completion" jsonb;
