# Inbound media vision promotion gate

`ELIZA_APP_INBOUND_MEDIA_VISION` must remain unset outside tests. The default
raw-media path is the supported deployment posture until every gate below has
reviewable evidence:

- a bounded retention policy and scheduled purge for stored image descriptions,
  with tenant-deletion and expiry tests;
- real PostgreSQL concurrent admission/reclaim coverage that exercises row-lock
  interleaving rather than PGlite's serialized transaction harness;
- a live signed Blooio delivery through the gateway, Worker, media fetch, vision
  provider, settlement ledger, and reply path, including redelivery evidence;
- confirmed Cloudflare egress enforcement for the documented `safeFetch`
  DNS-rebinding residual on workerd; and
- operator-approved daily ceilings with explicit nonblank bindings.

Enabling the flag is a deployment change, not evidence that these gates passed.
The gateway and Worker bindings must be promoted together only after the same
exact source revision has satisfied the checklist.
