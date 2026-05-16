# ElizaOS homepage

Landing page for the ElizaOS operating system product surface.

Production target:

- Cloudflare Pages project: `elizaos-homepage`
- Default URL: `https://elizaos-homepage.pages.dev`
- Intended custom domain: `https://os.elizacloud.ai`

Deploy:

```sh
bun run --cwd packages/os-homepage build
bun run --cwd packages/os-homepage deploy -- --commit-dirty=true
```

`os.elizacloud.ai` must point at the Pages project with a CNAME before
Cloudflare can finish custom-domain verification.
