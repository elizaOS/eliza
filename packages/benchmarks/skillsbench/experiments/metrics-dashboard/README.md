# metrics-dashboard

Experimental SkillsBench metrics dashboard (Vite + React + Tailwind v4). Private,
not published.

## Building

This is a self-contained sub-project with its own `bun.lock`. Build it from this
directory:

```bash
bun install
bun run build:standalone   # tsc -b && vite build
bun run dev                # local dev server
```

The build task is intentionally named `build:standalone` (not `build`) so the
monorepo's turbo build and `run-examples-benchmarks.mjs` skip it. Under the
workspace's hoisted dependency layout the Tailwind v4 PostCSS pipeline fails to
resolve (`globals.css:undefined:NaN`), even though the standalone build is green.
Keeping it out of the shared build graph stops it from breaking the `ci` lane
while remaining fully buildable on its own.
