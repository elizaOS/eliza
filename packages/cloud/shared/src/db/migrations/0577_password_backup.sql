CREATE TABLE password_backups (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot bytea CHECK (octet_length(snapshot) BETWEEN 1 AND 2097152),
  PRIMARY KEY (app_id, organization_id, user_id)
);
