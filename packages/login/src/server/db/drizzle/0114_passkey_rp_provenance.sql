-- Bind newly registered passkeys to the WebAuthn relying-party ID that
-- created them. Existing credentials remain NULL: a deployment can serve
-- multiple RPs, so assigning one RP to every legacy row would be unsafe.
-- Successful WebAuthn authentication opportunistically fills this column,
-- which proves the credential's RP through the verified rpIdHash.
ALTER TABLE "authenticators" ADD COLUMN "rp_id" varchar(253);
