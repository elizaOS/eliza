# Package Infra Charts

This directory only contains package-owned shared/local charts.

There is no gateway-discord chart anymore: the service-local
`cloud/services/gateway-discord/chart` was deleted together with its EKS
Terraform when the gateways moved to Railway (see
[`../AWS_RETIREMENT.md`](../AWS_RETIREMENT.md)), and the local kind cluster no
longer deploys gateway services either (`../local/setup.sh`). Do not add a
`gateway-discord` chart here.
