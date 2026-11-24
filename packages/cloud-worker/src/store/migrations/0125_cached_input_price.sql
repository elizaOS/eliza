ALTER TABLE model_prices ADD COLUMN cached_input_per_1k bigint;
UPDATE model_prices SET cached_input_per_1k = input_per_1k;
ALTER TABLE model_prices ALTER COLUMN cached_input_per_1k SET NOT NULL;
ALTER TABLE model_prices ADD CONSTRAINT model_prices_cached_input_per_1k_check CHECK (cached_input_per_1k BETWEEN 0 AND input_per_1k);
