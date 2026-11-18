ALTER TABLE cloud_google_calendar_reminders
  ADD COLUMN IF NOT EXISTS display_title text NOT NULL DEFAULT 'Appointment';
