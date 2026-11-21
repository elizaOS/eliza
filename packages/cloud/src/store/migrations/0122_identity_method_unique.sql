DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'cloud_sign_in_identities'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (account_id, provider)'
  ) THEN
    RETURN;
  END IF;

  LOCK TABLE cloud_sign_in_identities IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM cloud_sign_in_identities
    GROUP BY account_id, provider HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'historical sign-in methods contain more than one identity of the same kind for an account';
  END IF;

  ALTER TABLE cloud_sign_in_identities
    ADD CONSTRAINT cloud_sign_in_identities_account_id_provider_key UNIQUE (account_id, provider);
END;
$migration$;
