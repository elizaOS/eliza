# Steward.fi — Final Sprint Plan
**Created:** 2026-03-14 03:15 MDT
**Deadline:** March 22, 2026 (8 days)

---

## Worker Assignments

### Worker 1: Dashboard Polish & Interactive Flows
**Priority: HIGH** — judges will click through this
- Verify all CRUD flows work end-to-end against live API
- Create agent form → actually creates on api.steward.fi
- Approve/reject in approvals page → hits real endpoints
- Agent detail page ([id]) — policies display, tx history, balance
- Transaction list — filters, status badges, BaseScan links
- Settings page — API key display, SDK snippet with @stwd/sdk
- Overview dashboard — stats cards, recent activity, pending count
- Fix any broken flows, error states, loading states
- Mobile responsive check (judges may view on phone)

### Worker 2: Submission Doc & Landing Page Copy
**Priority: HIGH** — this is what judges read first
- Polish SUBMISSION.md into final pitch form
- Update all references to @stwd/sdk
- Add live demo links, npm badge, GitHub stats
- Architecture diagram (ASCII or link to image)
- Demo walkthrough: step-by-step what to click
- Verify line counts, feature claims are accurate
- Landing page (web/src/app/page.tsx) copy review — make it sell
- Ensure code examples use @stwd/sdk everywhere

### Worker 3: Eliza/Waifu Integration + API Hardening
**Priority: MEDIUM-HIGH** — demonstrates real-world use
- Review eliza-cloud codebase for Steward integration points
- Build lightweight Steward plugin/hook for eliza agent framework
- Or: document the integration path clearly in submission
- API hardening: error messages, edge cases, rate limiting
- Ensure waifu.fun tenant demo data is compelling
- Verify balance endpoint, batch creation, all new endpoints
- Redeploy API to eliza VPS with @stwd/* package names

### Worker 4: Deploy & E2E Verification
**Priority: HIGH** — nothing matters if prod is broken
- Rsync latest code to eliza VPS (excluding .env)
- Restart steward-api service
- Verify all API endpoints respond correctly
- Redeploy web to Vercel
- Full E2E test: create agent → set policies → sign tx → verify on-chain
- Test dashboard against live API
- Verify npm package @stwd/sdk installs and works
- SSL/CORS/headers check on api.steward.fi

---

## Key Files
- API: `packages/api/src/index.ts` (874 lines)
- Vault: `packages/vault/src/vault.ts` (282 lines)  
- SDK: `packages/sdk/src/` (412 lines)
- Web: `web/src/` (2764 lines across all pages)
- Submission: `SUBMISSION.md` (225 lines)
- Landing: `web/src/app/page.tsx` (462 lines)
- Dashboard pages: agents, approvals, transactions, settings, overview, agent detail
- Waifu bridge: `packages/api/src/services/waifu-bridge.ts` (148 lines)

## Deployment
- API: eliza VPS (89.167.63.246), systemd `steward-api.service`, port 3200
- Web: Vercel, deploy from `web/` directory
- Tunnel: cloudflared `api.steward.fi` → localhost:3200
- Auth: `X-Steward-Tenant` + `X-Steward-Key` headers
