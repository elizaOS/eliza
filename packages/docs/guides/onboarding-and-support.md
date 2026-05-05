---
title: "First-day setup and support"
sidebarTitle: "Setup & support"
description: "Short path to a working install, first-run choices, and how to file a useful report."
---

# First-day setup and support

Goal: a **working first configuration in minutes**, and a **clear template** when something goes wrong.

## 1. Install and launch

**Fresh clone:**

```bash
./install        # Unix / macOS (initializes submodules + installs deps)
# install.cmd    # Windows
bun run dev      # API on :31337, UI on :2138 with hot reload
```

**Existing checkout (submodules already on disk):**

```bash
bun install
bun run dev
```

Open the web UI at `http://localhost:2138` or the desktop app and complete first-run onboarding. A slower cold start the first time is normal.

## 2. First-run paths

- **Eliza Cloud** — fastest path when you want managed setup.
- **Bring your own key (BYOK)** — when you already have OpenAI, Anthropic, OpenRouter, or similar keys.

Ship one working configuration first; optimize later.

## 3. Cloud vs BYOK (mental model)

- Signing in to Eliza Cloud does **not** force Cloud inference.
- You can stay connected to Cloud and route inference through BYOK providers.
- Some routing changes require a **restart**; the UI will say so.

Details: [Cloud and provider routing](/guides/cloud-provider-routing).

## 4. Common failures

### Browser sign-in fails

- Confirm the system browser can open external links.
- Use **Retry** in the UI.
- If needed, connect via the API key path first, then return to browser login.

### Model does not match what you selected

- Confirm the active provider in settings.
- Look for a **restart required** banner; restart and retry.

### Quota or call errors

- Check Cloud balance if using Cloud inference.
- If you intend BYOK-only, ensure Cloud inference is off.

## 5. Issue template (copy/paste)

```md
## Summary
One sentence describing the problem.

## Steps
1.
2.
3.

## Expected
What should happen.

## Actual
What happened.

## Environment
- OS:
- Bun / Node:
- Provider:
- Cloud connected: yes/no

## Logs / screenshots
Paste errors or attach screenshots.
```

## 6. Where to report

- In-app reporting where offered for Cloud or onboarding errors.
- GitHub: <https://github.com/eliza-ai/eliza/issues>

## Related (Chinese)

- [中文入门：安装、引导与支持](/zh/guides/onboarding-and-support)
