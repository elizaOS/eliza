# Cloud tooling

Private operational and test scripts for Eliza Cloud. The package declares its
workspace imports locally so they do not invalidate unrelated build caches.
Invoke operations through their documented root commands; run the script test
lane with `bun run test:scripts` from the repository root.

Gateway deployment, verification, homepage readiness, and DNS operations belong
here. Invoke them with `bun run --cwd packages/cloud/scripts sms-gateway:verify:cloud-prod`
or the corresponding `sms-gateway:*` command in this package. Device installation
and pairing remain in the app package.

Run Cloud Latency Certification from `staging` for staging or `main` for
production. Select the matching environment and exact served commit. Both use
`qwen-3.8-27b@high@max` by default and retain sanitized request traces. Auth cache
probes are available only in staging. Production uses the protected production
environment and the root Worker placement policy from the deployed commit.

The staging database identity report can query the recorded Hetzner server IDs
for agents blocked by migration 0398. Enable `read_only_agent_provider_state` to
emit hashed subjects and provider-state comparisons. A server absent from the
configured project does not establish historical billing or authorize a repair.
