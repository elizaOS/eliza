CREATE TABLE cloud_mail_device_authorizations (
  device_key text NOT NULL REFERENCES device_grants(key) ON DELETE CASCADE,
  origin text NOT NULL,
  request text NOT NULL UNIQUE,
  requested_at bigint NOT NULL,
  session_key text REFERENCES sessions(key) ON DELETE CASCADE,
  grant_id uuid,
  PRIMARY KEY (device_key, origin),
  CHECK ((session_key IS NULL) = (grant_id IS NULL))
);
