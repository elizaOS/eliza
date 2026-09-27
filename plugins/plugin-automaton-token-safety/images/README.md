# images/ — required registry assets (to be supplied by the operator)

The ElizaOS plugin registry requires two binary images in this folder before publishing:

| File | Size | Max weight | Purpose |
|---|---|---|---|
| `logo.jpg` | 400 × 400 px | 500 KB | Plugin icon in the registry |
| `banner.jpg` | 1280 × 640 px | 1 MB | Header image on the plugin page |

They are brand assets and are intentionally not generated here. Add both files (JPEG) with those
exact names before running the registry publish flow. Nothing in this folder is read at runtime.
