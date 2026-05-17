# Package Infra Charts

This directory only contains package-owned shared/local charts.

Gateway Discord chart ownership is service-local at:

```text
cloud/services/gateway-discord/chart
```

CI and local setup both deploy that service-local chart. Do not add a second `gateway-discord` chart here.
