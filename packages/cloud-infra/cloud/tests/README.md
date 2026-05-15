# Operator E2E Tests (Chainsaw)

End-to-end tests for the Eliza Server Operator using [Chainsaw](https://kyverno.github.io/chainsaw/) (Kyverno).

## Prerequisites

```bash
brew tap kyverno/chainsaw https://github.com/kyverno/chainsaw
brew install kyverno/chainsaw/chainsaw
```

The local Kind cluster must be running with the operator deployed (`infra/local/setup.sh`).

## Running

```bash
cd infra/tests

# All suites (run in parallel, ~55s)
chainsaw test --config .chainsaw.yaml

# Single suite
chainsaw test --test-dir 01-generated-fields/ --config .chainsaw.yaml

# With JUnit report (CI)
chainsaw test --config .chainsaw.yaml --report-format XML --report-name results
```

## What's tested

### System under test

The **Server Operator** (Pepr) watches `Server` CRs (`servers.eliza.ai/v1alpha1`) and generates:
- **Deployment** — runs the agent-server container (image, resources, probes, env vars, secretRef)
- **Service** — ClusterIP on port 3000 with `eliza.ai/server` selector
- **ScaledObject** — KEDA scale-to-zero via Redis list trigger `keda:{name}:activity`
- **Redis state** — `server:{name}:status`, `server:{name}:url`, `agent:{id}:server`
- **CR status** — `phase`, `observedGeneration`, `readyAgents`, `totalAgents`, `lastActivity`

The **Agent Server** (Elysia HTTP) runs inside the Deployment and exposes:
- Health/readiness probes (`/health`, `/ready`)
- Agent CRUD (`POST /agents`, `DELETE /agents/:id`, `POST /agents/:id/stop`)
- Messaging (`POST /agents/:id/message`)
- Status reporting (`GET /status`)

### Coverage per spec field

| CRD field | Tested in |
|---|---|
| `spec.capacity` | 01 (env var), 03 (503 at capacity) |
| `spec.tier` | 01 (labels), 04 (different tiers), 05 (patch tier) |
| `spec.image` | 01 (container image) |
| `spec.project` | 01 (labels), 04 (different projects), 05 (patch project) |
| `spec.maxReplicas` | 01 (ScaledObject), 05 (patch maxReplicas) |
| `spec.secretRef` | 01 (envFrom), 05 (patch secretRef) |
| `spec.resources` | 01 (container resources), 05 (patch resources) |
| `spec.agents` | 02 (create/stop/delete), 03 (multi-agent) |
| `status.phase` | 01, 04 (Pending after reconcile), 02 (Running after pod ready) |
| `status.observedGeneration` | 05 (advances after patches) |

### Coverage per HTTP endpoint

| Endpoint | Tested in |
|---|---|
| `GET /health` → 200 `{alive:true}` | 02 |
| `GET /ready` → 200 `{ready:true}` | 02 |
| `GET /status` → 200 `{serverName, agentCount}` | 02, 03 |
| `POST /agents` → 201 `{status:"running"}` | 02, 03 |
| `POST /agents` → 400 (empty body) | 02 |
| `POST /agents` → 409 (duplicate agentId) | 03 |
| `POST /agents` → 503 (at capacity) | 03 |
| `POST /agents/:id/message` → 200 `{response}` | 02, 03 |
| `POST /agents/:id/message` → 400 (empty body) | 02 |
| `POST /agents/:id/message` → 404 (not found/stopped) | 02 |
| `POST /agents/:id/stop` → 200 `{status:"stopped"}` | 02 |
| `POST /agents/:id/stop` → 404 (not found) | 02 |
| `DELETE /agents/:id` → 200 `{deleted:true}` | 02, 03 |
| `DELETE /agents/:id` → 404 (not found) | 02 |

### Coverage per operator behavior

| Behavior | Tested in |
|---|---|
| Deployment generated with correct labels, probes, ports, envFrom | 01 |
| Service generated with ClusterIP, port 3000, correct selector | 01 |
| ScaledObject generated with correct KEDA trigger (Redis list) | 01 |
| Env vars injected: SERVER_NAME, CAPACITY, TIER, POD_NAME (fieldRef) | 01 |
| Redis state written: `server:{name}:status`, `server:{name}:url` | 01 |
| CR status set to `phase: Pending` after reconcile | 01, 04 |
| Multiple Server CRs coexist with distinct resources | 04 |
| KEDA ScaledObjects use distinct trigger keys per server | 04 |
| Deleting one Server CR does not affect another's resources | 04 |
| Patching CR re-reconciles child resources (maxReplicas, resources, project, tier, secretRef) | 05 |
| `observedGeneration` advances with each reconcile | 05 |
| KEDA wake: LPUSH to activity list scales pod from 0→1 | 02, 03 |
| Shared tier auto-starts "eliza" agent (async) | 03 (handled dynamically) |

---

## Test Suites

### 01-generated-fields (~10s, no pods needed)

Verifies the operator generates correct K8s resources from a Server CR.

| Assertion | Method |
|---|---|
| Deployment labels: `managed-by`, `server`, `tier`, `project` | K8s assert on metadata + pod template |
| Container: image, port 3000, envFrom secretRef | K8s assert on container spec |
| Resource requests/limits propagated from CR | K8s assert on container resources |
| Readiness probe `/ready:3000`, liveness probe `/health:3000` | K8s assert on probes |
| Env vars: SERVER_NAME, CAPACITY, TIER values + POD_NAME fieldRef | Script checking jsonpath |
| Service: ClusterIP, port 3000, selector `eliza.ai/server` | K8s assert on Service |
| ScaledObject: min=0, max from CR, cooldown=900, polling=30 | K8s assert on ScaledObject |
| KEDA trigger: type=redis, listName=`keda:{name}:activity`, threshold=1 | K8s assert on trigger |
| Redis keys: `server:{name}:status`=pending, `server:{name}:url` set | Script via ephemeral redis-cli pod |
| CR status: `phase: Pending` | K8s assert on Server CR |

### 02-agent-lifecycle (~55s, requires running pod)

Full CRUD agent lifecycle via HTTP. Wakes pod via KEDA.

| Assertion | Method |
|---|---|
| KEDA wake via LPUSH scales pod 0→1 | Redis LPUSH + wait pod Ready |
| CR phase transitions to Running after pod ready | K8s jsonpath on Server CR |
| `GET /health` → `{alive:true}` | curl |
| `GET /ready` → `{ready:true}` | curl |
| `GET /status` → contains `serverName` | curl |
| `POST /agents` → 201, `{status:"running"}` | curl + HTTP code + body |
| agentCount increases after create | curl /status |
| `POST /agents/:id/message` → `{response}` | curl |
| `POST /agents/:id/stop` → `{status:"stopped"}` | curl |
| Message to stopped agent → 404 | curl HTTP code |
| `DELETE /agents/:id` → `{deleted:true}` | curl |
| Message to nonexistent agent → 404 | curl HTTP code |
| Stop/delete already-deleted agent → 404 | curl HTTP code |
| Empty body on create → 400 | curl HTTP code |
| Empty body on message → 400 | curl HTTP code |

### 03-multi-agent-capacity (~55s, requires running pod)

Multi-agent management and capacity enforcement. `capacity: 3`.

| Assertion | Method |
|---|---|
| Fill to capacity dynamically (handles async eliza auto-start) | Loop creating agents |
| At capacity: agentCount = 3 | curl /status |
| Over capacity → 503 | curl HTTP code |
| Duplicate at capacity → 503 (capacity checked first) | curl HTTP code |
| Delete frees slot, count decreases | DELETE + /status check |
| Duplicate below capacity → 409 | curl HTTP code |
| Create in freed slot → 201 | curl HTTP code |
| Multiple agents respond independently | curl /message on each |

### 04-horizontal-multi-server (~7s, no pods needed)

Two independent Server CRs with different tiers/projects. Pure K8s assertions.

| Assertion | Method |
|---|---|
| Alpha Deployment: labels project=alpha, tier=shared | K8s assert file |
| Beta Deployment: labels project=beta, tier=dedicated | K8s assert file |
| Alpha Service with selector `eliza.ai/server: srv-alpha` | K8s assert |
| Beta Service with selector `eliza.ai/server: srv-beta` | K8s assert |
| Alpha ScaledObject trigger: `keda:srv-alpha:activity` | K8s assert |
| Beta ScaledObject trigger: `keda:srv-beta:activity` | K8s assert |
| Both CRs reconciled: `status.phase: Pending` | K8s assert (proves Redis written) |
| After deleting alpha: beta Deployment still exists | K8s assert |
| After deleting alpha: beta Service still exists | K8s assert |
| After deleting alpha: beta ScaledObject still exists | K8s assert |
| After deleting alpha: beta CR status still Pending | K8s assert |

### 05-vertical-scaling (~6s, no pods needed)

Patch a Server CR, verify operator re-reconciles child resources.

| Assertion | Method |
|---|---|
| Baseline: maxReplicas=1, project=cloud, memory=256Mi | K8s assert |
| Patch maxReplicas 1→5 → ScaledObject updated | K8s assert after patch |
| Patch resources 256Mi→512Mi, 100m→200m, 1Gi→2Gi, 500m→1 | K8s assert after patch |
| Patch project cloud→soulmate → Deployment labels updated | K8s assert after patch |
| Patch tier shared→dedicated → Deployment labels updated | K8s assert after patch |
| Patch secretRef → Deployment envFrom updated | K8s assert after patch |
| observedGeneration > 1 after multiple patches | Script checking jsonpath |

---

## Architecture

```
infra/tests/
├── .chainsaw.yaml                              # Global config (timeouts, cleanup)
├── README.md
├── 01-generated-fields/
│   ├── chainsaw-test.yaml                      # Test steps
│   ├── server-cr.yaml                          # Input: Server CR (capacity=10, shared, cloud)
│   ├── assert-deployment.yaml                  # Expected Deployment fields
│   ├── assert-service.yaml                     # Expected Service fields
│   └── assert-scaledobject.yaml                # Expected ScaledObject fields
├── 02-agent-lifecycle/
│   ├── chainsaw-test.yaml                      # KEDA wake + HTTP lifecycle
│   └── server-cr.yaml                          # Input: capacity=5, shared
├── 03-multi-agent-capacity/
│   ├── chainsaw-test.yaml                      # Capacity enforcement
│   └── server-cr.yaml                          # Input: capacity=3, shared
├── 04-horizontal-multi-server/
│   ├── chainsaw-test.yaml                      # Isolation test
│   ├── server-alpha.yaml                       # Input: shared/alpha
│   ├── server-beta.yaml                        # Input: dedicated/beta
│   ├── assert-alpha-deployment.yaml            # Expected alpha labels
│   └── assert-beta-deployment.yaml             # Expected beta labels
└── 05-vertical-scaling/
    ├── chainsaw-test.yaml                      # Patch + re-reconcile
    └── server-cr.yaml                          # Input: maxReplicas=1, cloud
```

**Fast suites (K8s assertions only):** 01, 04, 05 — ~7-11s each, no pods needed.
**HTTP suites (require running pod):** 02, 03 — ~55s each, KEDA wake + port-forward.

All 5 suites run in parallel. Cleanup is automatic via Chainsaw (resources created with `apply` are deleted after each test).

## Not tested (out of scope)

- `POST /drain` endpoint (graceful shutdown) — requires SIGTERM simulation
- `status.phase` transitions to ScaledDown/Draining — requires KEDA cooldown or SIGTERM simulation
- Agent-server Redis writes (`agent:{id}:server` mappings from reconciler) — tested indirectly via capacity
- KEDA scale-down (cooldownPeriod=900s timeout makes it impractical in e2e)
- Resource defaults (512Mi/250m) — tests use explicit resource values from CR
