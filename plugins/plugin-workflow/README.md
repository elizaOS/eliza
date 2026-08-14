# @elizaos/plugin-workflow

Native [Smithers](https://www.npmjs.com/package/smthrs) workflows for elizaOS.

Workflows are executable TS/TSX modules, authored from chat or the Workflows studio and run behind elizaOS authentication, tenancy, Cloud APIs, scheduling, and model routing. The integration does not run a Smithers Gateway. Native Smithers progress, outputs, approvals, and widget metadata are surfaced through elizaOS run records and UI.

See [CLAUDE.md](./CLAUDE.md) for the source contract, architecture, routes, and validation commands.

`ELIZA_SMTHRS_TIMEOUT_MS` optionally sets the worker deadline in milliseconds. It accepts canonical decimal integers from `1` through `2147483647`; invalid configuration fails before worker startup.
