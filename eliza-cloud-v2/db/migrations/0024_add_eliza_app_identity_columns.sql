-- Migration: Add Eliza App identity columns to users table
-- Supports Telegram Login and iMessage (phone) authentication

-- Add Telegram identity columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_photo_url TEXT;

-- Add phone identity columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS users_telegram_id_idx ON users(telegram_id) WHERE telegram_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_phone_number_idx ON users(phone_number) WHERE phone_number IS NOT NULL;
