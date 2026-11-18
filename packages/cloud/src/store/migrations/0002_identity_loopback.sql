CREATE TABLE loopback_messages (
  seq bigserial PRIMARY KEY,
  destination text NOT NULL,
  text text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX loopback_messages_latest ON loopback_messages (destination, seq DESC);
