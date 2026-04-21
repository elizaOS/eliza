Archived app assets that should stay in-repo but not ship in the runtime bundle.

`apps/app/public/` is Vite's live static asset root and gets copied into builds.
Move source-only, debug, or superseded assets here when they are useful to keep
around but should not increase packaged app size.
