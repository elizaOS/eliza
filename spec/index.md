# Eliza

Eliza is an agent runtime and the packages a product builds on it: the
kernel, the agent host, identity and sign-in, the Android device image, the
hosted cloud services and the assistant plugins. Each package is specified
top-down here before its VibeLang and Effect implementation: stories, then
rules, then the Quint model the generated code and proofs come from. A
change to Eliza starts in this tree.

Products compose these packages and keep their own interfaces, branding and
deployments. A branded cloud deployment imports the cloud and auth packages
and supplies its own configuration. Eliza names no product: what a product
needs is stated as a generic capability of the package that owns it, and
[consumer contracts](./core/consumerContracts.md) state how a consumer's
recorded imports are traced to an owning rule.

The research baseline is elizaOS/eliza commit
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The toolchain is vendored from
the Vibestack consolidation at `7d18b1c`.

| Package | Specification |
| --- | --- |
| `@elizaos/core` | [Kernel](./core/) |
| `@elizaos/contracts` | [Wire contracts](./contracts/) |
| `@elizaos/agent` | [Agent host](./agent/) |
| `@elizaos/auth` | [Identity and sign-in](./auth/) |
| `@elizaos/os` | [Device image, native bridges and voice](./os/) |
| `@elizaos/cloud` | [Hosted services](./cloud/) |
| `@elizaos/plugin-workflow` | [Workflows](./workflow/) |
| `@elizaos/plugin-browser` | [Browser automation](./browser/) |
| `@elizaos/plugin-calendar` | [Calendar](./calendar/) |
| `@elizaos/plugin-inbox` | [Inbox](./inbox/) |
| `@elizaos/plugin-notes` | [Notes](./notes/) |
| `@elizaos/plugin-maps` | [Maps](./maps/) |
| `@elizaos/plugin-files` | [Files](./files/) |
| `@elizaos/plugin-personal-assistant` | [Personal assistance](./assistant/) |
| `@elizaos/plugin-local-inference` | [Local inference](./localInference/) |

Eliza has no shared user interface, training, benchmark, testing or script
package. Cloud-hosted user applications are not part of Eliza.
