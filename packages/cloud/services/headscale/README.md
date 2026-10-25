# Headscale policy

Source of truth for the Eliza Cloud tailnet ACL in `acl.hujson`. The Hetzner
control-plane workflow deploys it to `/etc/headscale/acl.hujson`; edit this file
rather than the admin UI. There is no standalone build.

Keep internal `tag:agent` traffic isolated from customer `tag:eliza-tunnel`
traffic. `tag:eliza-proxy` reaches customer HTTPS endpoints and agent port 2138;
customer routing remains subject to tenant authorization.

There is no standalone test suite in this directory. Validate policy changes
through an authorized staging control-plane deployment before production.
