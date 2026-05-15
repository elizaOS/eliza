# elizaOS Plugin Registry Site

This Vite app renders the public registry catalog from
`generated-registry.json`.

## Local Development

```sh
pnpm install
pnpm dev
```

The production build copies the registry JSON outputs into `site/public` before
Vite builds:

```sh
pnpm build
```
