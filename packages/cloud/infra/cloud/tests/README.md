# Operator integration scenarios

Chainsaw scenarios exercise Server CRDs, generated workloads, scaling, routing,
PostgreSQL, Redis, gateway delivery, and crash recovery. They require the isolated
local Kubernetes stack prepared by `../local/setup.sh`, including its operator,
KEDA, and CNPG controllers. They are not the database PITR drill.

Run these scenarios with the installed Chainsaw test runner against that local
cluster. Never target a shared or production cluster: the scenarios create,
scale, and delete workloads in `eliza-agents`.

The separate database recovery drill is `bun run --cwd packages/cloud/infra test:pitr`
from the repository root. Cloud Tests owns Go tests and Python/shell syntax checks;
cluster scenarios remain an operator-run integration lane.
