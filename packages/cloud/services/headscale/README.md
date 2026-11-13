# Headscale policy

Source of truth for the Eliza Cloud tailnet ACL in `acl.hujson`. The Hetzner
control-plane workflow deploys it to `/etc/headscale/acl.hujson`; edit this file
rather than the admin UI. There is no standalone build.

Keep internal `tag:agent` traffic isolated from customer `tag:eliza-tunnel`
traffic. `tag:eliza-proxy` reaches customer HTTPS endpoints and agent port 2138;
customer routing remains subject to tenant authorization. New control-plane
routers enroll with `tag:eliza-cp`, which reaches only agent port 2138.

Existing routers keep their current tag when enrollment is already healthy.
Retag each environment's router with `headscale nodes tag -i <id> -t tag:eliza-cp`,
then confirm its stored tag and agent connectivity. The preauth key is the tag
authority; do not add `--advertise-tags` to the enrollment command. Keep the
proxy-to-agent rule until both environments pass this check. Remove that rule
in a separate change and verify the tunnel proxy can no longer reach agents.

There is no standalone test suite in this directory. Validate policy changes
through an authorized staging control-plane deployment before production.
