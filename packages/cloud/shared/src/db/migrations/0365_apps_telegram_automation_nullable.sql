-- Restore accepts an explicitly absent Telegram configuration, as declared by the app schema.
ALTER TABLE "apps" ALTER COLUMN "telegram_automation" DROP NOT NULL;
