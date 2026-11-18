CREATE TABLE IF NOT EXISTS maps_requests (
  hold_key text PRIMARY KEY REFERENCES holds (key),
  operation text NOT NULL CHECK (operation IN ('geocode', 'reverse', 'places_search', 'place_details', 'routes', 'tile')),
  request_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'answered', 'refused', 'lost', 'released')),
  result jsonb,
  kept_at bigint,
  created_at bigint NOT NULL,
  CHECK (operation <> 'tile' OR result IS NULL)
);
CREATE INDEX IF NOT EXISTS maps_requests_kept ON maps_requests (kept_at) WHERE result IS NOT NULL;
