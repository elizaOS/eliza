# Eliza

Eliza is an agent runtime and the packages a product builds on it: the
kernel, the on-device agent, the Android device package, the hosted cloud
services and the assistant plugins. Each package is specified top-down here
before its VibeLang and Effect implementation: stories, then rules, then the
Quint model that the generated code and proofs come from. A change to Eliza
starts in this tree.

Agents run on the owner's device. The cloud hosts no agent; it serves
identity, accounts, billing and the metered services the on-device agent
calls. Products compose these packages and keep their own interfaces,
branding and deployments. A product's cloud deployment runs the cloud
package with its own deployment profile. Eliza names no product: what a
product needs is stated as a generic capability of the package that owns it,
and [consumer contracts](./core/consumerContracts.md) state how a consumer's
recorded imports are traced to an owning rule. Each record and state machine
has one owner. Specs may import across packages only in this direction: os →
agent → cloud → core; plugins import from these packages, and these packages
never import from plugins.

| Package | Specification |
| --- | --- |
| `@elizaos/core` | [Kernel](./core/) |
| `@elizaos/agent` | [On-device agent: the Node process that runs one owner's agent, its local API, and the client and voice libraries that screens use](./agent/) |
| `@elizaos/os` | [Android device: the agent service, device sign-in and credential custody, native bridges, device audio and listener, browser, and the image, APK and update build library](./os/) |
| `@elizaos/cloud` | [Hosted services: identity and sessions, native clients and device keys, billing and entitlements, metered inference, speech and maps, managed Google, and the client that devices use](./cloud/) |
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
package. `packages/ui` and `packages/design-system` are the toolchain's
private React components and design tokens, not a published Eliza package.
Cloud-hosted user applications, cloud-run agents, sandboxes and remote
pairing to a hosted agent are not part of Eliza.
