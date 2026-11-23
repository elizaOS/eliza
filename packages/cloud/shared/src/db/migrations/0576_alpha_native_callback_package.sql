-- Keep the legacy login alias, but return both client IDs to the canonical installed app.
-- Change only an approved Alpha registration when its canonical sibling and exact callback match.
UPDATE mobile_app_auth_clients AS client
SET callback_android_package = 'ai.alphacompute.alphaphone', updated_at = now()
FROM mobile_app_auth_clients AS canonical
JOIN apps AS app ON app.id = canonical.app_id
WHERE canonical.client_id = 'ai.alphacompute.alphaphone'
  AND canonical.enabled AND app.is_active AND app.is_approved
  AND canonical.redirect_uri ~ '^https://[^/]+/alphaphone/auth/callback$'
  AND canonical.android_package_name = 'ai.alphacompute.alphaphone'
  AND client.app_id = canonical.app_id
  AND client.redirect_uri = canonical.redirect_uri
  AND client.client_id IN ('ai.alphacompute.alphaphone', 'ai.elizaresearch.alphaphone')
  AND client.callback_android_package IS DISTINCT FROM 'ai.alphacompute.alphaphone'
  AND (client.callback_android_package IS NULL OR client.callback_android_package = 'ai.elizaresearch.alphaphone');
