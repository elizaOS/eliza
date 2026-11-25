ALTER TABLE quotes DROP CONSTRAINT quotes_command_kind_check;
ALTER TABLE quotes ADD CONSTRAINT quotes_command_kind_check CHECK (command_kind IN ('upgrade', 'downgrade', 'undo'));
