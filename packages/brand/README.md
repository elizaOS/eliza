# @elizaos/brand

Shared elizaOS brand assets and constants for web apps.

Runtime web apps should serve the static files from `/brand/...` by copying
`assets/*` into the app public directory as `public/brand/*`.

Use the TypeScript constants when code needs stable asset URLs:

```ts
import { brandLogos, brandCloudBackgrounds } from "@elizaos/brand";
```

Use the CSS variables by importing:

```ts
import "@elizaos/brand/brand.css";
```
