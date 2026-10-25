CREATE OR REPLACE FUNCTION "steward_bootstrap"."ensure_default_tenant"(p_api_key_hash text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  existing_hash text;
BEGIN
  SELECT tenant.api_key_hash INTO existing_hash
  FROM public.tenants tenant
  WHERE tenant.id = 'default';

  IF FOUND THEN
    IF p_api_key_hash <> '' AND existing_hash IS DISTINCT FROM p_api_key_hash THEN
      RAISE EXCEPTION 'DEFAULT_TENANT_API_KEY_MISMATCH';
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.tenants(id, name, api_key_hash)
  VALUES ('default', 'Default Tenant', p_api_key_hash)
  ON CONFLICT DO NOTHING;

  -- An empty development key is not authentication authority. If another
  -- fixture/tenant already owns that unique placeholder, leave `default`
  -- absent rather than aliasing the wrong tenant or crashing module startup.
  IF p_api_key_hash = '' THEN RETURN; END IF;

  SELECT tenant.api_key_hash INTO existing_hash
  FROM public.tenants tenant
  WHERE tenant.id = 'default';
  IF NOT FOUND OR existing_hash IS DISTINCT FROM p_api_key_hash THEN
    RAISE EXCEPTION 'DEFAULT_TENANT_API_KEY_CONFLICT';
  END IF;
END
$$;
