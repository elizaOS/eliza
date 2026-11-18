CREATE TABLE model_prices (
  model_id text PRIMARY KEY,
  input_per_1k bigint NOT NULL CHECK (input_per_1k BETWEEN 1 AND 10000000),
  output_per_1k bigint NOT NULL CHECK (output_per_1k BETWEEN 1 AND 10000000),
  updated_at bigint NOT NULL
);
