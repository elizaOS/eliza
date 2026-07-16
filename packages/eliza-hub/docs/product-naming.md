# Product Naming

## Recommendation

Use **Eliza Hub** for the product.

It is short, obvious, and flexible. The product is no longer only a Forgejo
theme or local Git mirror; it is becoming the place where agents, humans, code,
tasks, docs, queues, and Cloud identity meet.

## Naming Map

- **Eliza Hub**: overall product and navigation shell.
- **Eliza Git**: Forgejo-backed repositories, PRs, issues, packages, wiki, and
  Actions.
- **Eliza Work**: Eliza-native work items, cycles, modules, saved views,
  intake, pages, and dashboards.
- **Merge Steward**: backend service for queue policy, claims, audited
  overrides, integration branches, and merges.
- **Agent Runs**: durable Eliza workflow receipts attached to work items and
  PRs.

## Product Position

Eliza Hub should be "GitHub for agents" only as shorthand. The precise direction
is stronger:

- Forgejo remains the Git source of truth.
- Merge Steward provides the agent-native merge queue and policy engine.
- Eliza Cloud provides identity, agent runtime context, and dashboard surfaces.
- Eliza Work adds tasks, cycles, modules, views, intake, and pages around the
  code.
- Durable Eliza runs make agent work inspectable, resumable, and auditable.
