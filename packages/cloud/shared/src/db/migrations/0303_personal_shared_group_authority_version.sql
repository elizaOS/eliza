-- Monotonic generation used to invalidate in-flight group delivery authority.

ALTER TABLE personal_shared_group_bindings
  ADD COLUMN authority_version bigint NOT NULL DEFAULT 1;
