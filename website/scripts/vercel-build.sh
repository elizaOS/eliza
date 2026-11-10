#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
python3 website/scripts/build-site.py && python3 website/scripts/test-site.py && python3 scripts/test_private_pack_export.py && node website/scripts/test-wallet.cjs && node --test website/scripts/gate.test.cjs website/scripts/os.test.cjs website/scripts/desk.test.cjs website/scripts/host-route.test.cjs website/scripts/journey.test.cjs website/scripts/desktop.test.cjs website/scripts/minify.test.cjs website/scripts/supabase-auth.test.cjs website/scripts/feed.test.cjs && node website/scripts/minify-site.mjs
