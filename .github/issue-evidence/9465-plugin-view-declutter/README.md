# 9465 plugin view declutter evidence

Generated from real source components with deterministic fixture data:

```bash
node .github/issue-evidence/9465-plugin-view-declutter/capture-visuals.mjs \
  --before /private/tmp/eliza-9465-plugin-view-base \
  --after /private/tmp/eliza-9465-plugin-view-declutter \
  --out .github/issue-evidence/9465-plugin-view-declutter
```

Artifacts:

- `9465-plugin-view-declutter-before.png` — current `origin/develop` rendering of `DeviceSettingsAppView` and `ShopifyAppView`.
- `9465-plugin-view-declutter-after.png` — this branch rendering of the same source views and fixture data.
- `9465-plugin-view-declutter-after-walkthrough.webm` — after-state walkthrough switching Shopify tabs.
- `9465-plugin-view-declutter-qa.json` — source checkout paths and browser console error summary.

The harness imports the real view files from each checkout. Native system APIs
and Shopify API responses are deterministic stubs matching the package tests, so
the screenshots exercise the UI surface without requiring a phone or Shopify
credentials.
