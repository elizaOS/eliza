# ─────────────────────────────────────────────────────────────────────────────
# Config-driven import (Terraform 1.5+) — ADOPT the existing apps infra into
# apps-shared WITHOUT recreate.
#
# Background: the #8386 split moved the private network + tenant DB out of the
# per-env apps-data-plane module into THIS shared module (in config), but the
# live resources still live in the per-env STATE. This file lets `apps-shared`
# take ownership of the EXISTING Hetzner resources by ID instead of creating
# duplicates — the clean, standard migration this module was written for (every
# resource here already carries `lifecycle { ignore_changes = [name] }` so the
# post-import plan is a true no-op).
#
# IDs captured from the live staging data-plane plan (run 27450320924).
#
# NOTE: `random_password.tenant_db_admin` is intentionally NOT imported here —
# it was `state rm`'d from the per-env state during cleanup (#8400) and its real
# value lives on the tenant DB box. Adopting it cleanly is a separate decision
# (re-import the real value vs. regenerate; see #8321). Until then a plan will
# show it as the single "to add" — that is expected and isolates the one open
# item from the otherwise-clean infra adopt.
#
# Operational: this is a ONE-SHOT migration aid. After a clean `apply` adopts
# the resources, DELETE this file (the imports are idempotent but leaving stale
# import blocks is noise) and `state rm` the same addresses from each per-env
# apps-data-plane state so they stop showing as "to destroy" there.
# ─────────────────────────────────────────────────────────────────────────────

import {
  to = hcloud_network.apps
  id = "12318396"
}

import {
  to = hcloud_network_subnet.apps
  id = "12318396-10.30.1.0/24"
}

import {
  to = hcloud_firewall.tenant_db
  id = "11116583"
}

import {
  to = hcloud_server.tenant_db
  id = "139285074"
}

import {
  to = hcloud_server_network.tenant_db
  id = "139285074-12318396"
}

import {
  to = hcloud_volume.tenant_db_data
  id = "105978682"
}

import {
  to = hcloud_volume_attachment.tenant_db_data
  id = "105978682"
}
