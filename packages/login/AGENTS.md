# @elizaos/login

Owns product login, identity sessions and the browser client. React components
and hooks are exported from the `@elizaos/ui` root barrel.
Repository-wide instructions in [CLAUDE.md](../../CLAUDE.md) apply.

Keep browser and server entry points separate. Importing the browser
client must not load a database, server runtime or optional wallet adapters.
Preserve persisted identities, tokens and wire compatibility deliberately;
never rename a persisted key without a tested migration.

Do not add trading venues, strategies or DeFi integrations. Login supports
wallet signatures without requiring a trading stack.

Validate authentication at the transport boundary, including invalid input,
expired tokens, replay, tenant isolation, account linking and logout. Run
package tests, typecheck, lint and build plus repository verification. Real
provider/browser verification is required before claiming complete login proof.
