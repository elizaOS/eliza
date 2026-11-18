CREATE TABLE method_reviews (
  key text PRIMARY KEY REFERENCES accounts (key),
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  updated_at bigint NOT NULL
);
