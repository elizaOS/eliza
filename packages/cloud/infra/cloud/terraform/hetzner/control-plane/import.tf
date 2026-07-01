# One-shot adoption of the headscale A record that was created by hand during
# the 2026-06 headscale-on-CP cutover, before cloudflare_dns_record.headscale
# (in main.tf) existed. Without this, the first apply after this PR would try to
# CREATE an A record that already exists. Cloudflare record IDs are not secrets.
#
# Flow: staging imports on the next develop apply, production on the next
# (reviewer-gated) main apply. Post-import the block is a no-op, so it is safe to
# leave; remove this whole file in a follow-up once both envs' state has it.
locals {
  # CF DNS record IDs of the existing headscale A records, keyed by env.
  adopt_headscale_record_id = {
    staging    = "ca868231e69510b28761bb7fb60d2fb6"
    production = "c7eb58d332bec9a14e470a00966d932b"
  }
}

import {
  for_each = { "1" = local.adopt_headscale_record_id[var.environment] }
  to       = cloudflare_dns_record.headscale[each.key]
  id       = "${var.cloudflare_zone_id}/${each.value}"
}
