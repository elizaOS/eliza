# Cloudflare agent-server hosting

Runs one existing agent-server process in Cloudflare Containers. The server owns
authentication, agent lifecycle, tenant isolation, and its existing PostgreSQL
and shared-state records. This host does not replace Redis.

Supply `AGENT_SERVER_RUNTIME_CONFIG` as a JSON secret with string-valued runtime
settings. Preserve `SERVER_NAME`, capacity, tier, credentials, and database
selection. Use reachable storage endpoints and set `AGENT_SERVER_URL` to this
deployment's HTTPS Worker origin. Pin the tested runtime image by digest before
deploying. Staging and production have separate Container and Durable Object
bindings and start inactive.

Before enabling `AGENT_SERVER_ENABLED`, drain and stop the previous owner of
the same server identity, verify no agents or requests remain, and reconcile
its routing records. Verify authenticated status, heartbeat, allocation, agent
persistence, cancellation, and tenant isolation on the new host before retiring
the old deployment. Health alone does not prove agent acceptance.

Disable the flag to send SIGTERM on the next request or scheduled tick. Observe
the stopped container and reconcile in-flight work before starting another owner.
