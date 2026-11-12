-- Campaign identity is an operator input. Existing codes and grants retain
-- their exact family and redemption history; only omitted future input fails.
ALTER TABLE subscription_grant_codes ALTER COLUMN family DROP DEFAULT;
