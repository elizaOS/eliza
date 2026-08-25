# Group-room simulation (live behavioral evaluation)

Replays the five homepage demo rooms (Household, Co-parenting, Friends, Trip,
Community) against a running Eliza cloud stack as if real people were typing
in a linked iMessage group, and scores what the live Eliza does. One room per
invocation; verdict plus a readable transcript per room.

This is a **live-model behavioral evaluation, not a CI gate**. Two runs of
the same room will not produce the same transcript, and a PASS here is
evidence about one model/prompt/stack combination on one day, never proof of
a production integration. The deterministic, CI-safe part is the tool's own
test suite (`run-room-sim.test.ts`), which guards the spec derivation, the
plan, and the scorer's anti-gaming rules.

## What a room run proves

The room script is read at runtime from
`packages/homepage/src/lib/landing-demo.ts` (`LANDING_DEMO_SCENARIOS`,
`landingDemoStepText`, the `UNSUPPORTED_CLAIM_RULES` matcher and its
per-capability allow-list), so the rooms cannot drift from what the homepage
animates; there is no frozen copy to regenerate. Only the per-room key facts
and their relation/attribution/polarity matchers (`room-facts.ts`) are hand-written, and the
tests fail if the homepage gains a room that has no entry there.

The driver mirrors the real product flow in
`packages/cloud/api/internal/eliza-app/personal-shared/messages/route.ts`:

1. the owner DMs `/group` and the one-time `Eliza link <CODE>` command is
   parsed from the reply;
2. **pre-link silence probe**: a non-owner member posts a neutral line in
   the still-unlinked group and a bounded no-send window must stay empty;
3. the owner posts `Eliza link CODE` in the group (claim codes are bound to
   the requesting identity, so the same owner handle sends both);
4. because every room has Eliza interject without being named, the owner
   posts `Eliza ambient on` (exact-match owner command);
5. the human lines replay in script order. After a line that the homepage
   script follows with an Eliza step, the driver polls (bounded `WAIT_MS`)
   for replies; after every other line it holds a bounded `SILENCE_MS`
   window and anything that arrives counts as **unsolicited**.

Eight assertions, all of which must pass for a PASS verdict:

| Assertion | Rule |
| --- | --- |
| `respondedAtExpectedPoints` | at least `MIN_RESPONSES` scripted Eliza points got at least one reply (default `ceil(points/2)`, floor 1) |
| `silentUntilLinked` | zero group sends during the pre-link probe window |
| `restraintAtUnscriptedPoints` | unsolicited sends across all silent windows plus a trailing sweep are at most `UNSOLICITED_MAX` (default 2) |
| `noEchoedHumanText` | no Eliza output is a near-copy of a human line already sent (exact, containment of a 4+ token line, or token-Jaccard >= 0.8 against a 3+ token line) |
| `keyFactsReferenced` | at least `FACTS_MIN` distinct relation/attribution/polarity matchers appear at at least `FACTS_MIN` expected beats; a fact is eligible only where the homepage's expected beat contains the same structured evidence (default 2, floor 1) |
| `distinctExpectedReplies` | every non-echo expected reply is textually distinct, so one canned response cannot satisfy several beats |
| `noDetectedUnsupportedFirstPersonClaims` | no output (link/ambient acks included) trips the scoped first-person detector outside the categories the room's scripted capabilities allow. This is deliberately named as detection, not proof of absence: the parser handles explicit offers, completed acts, selected elided/passive completions, attribution switches and negation, while documented third-person/unlisted-verb blind spots remain. |
| `speakerAwareness` | some non-echo reply names a room member |

Anti-gaming rules, adversarially reviewed so a broken, echoing or
reply-to-everything agent cannot pass: echoed human text fails the run and
earns no fact or speaker credit; only outbound, non-human capture entries are
ever scored and human text never enters a matcher; acks are scanned for
forbidden claims; the first-person filter narrows where the homepage rules
run, never what they match (the rule set is imported untouched); `FACTS_MIN`
and `MIN_RESPONSES` cannot be zeroed. A
a noun-stuffing bot, a repeated-canned-reply bot, an echo bot and a chatty bot all fail in the test suite, and
a spec-faithful bot passes every room (the positive control).

## Files

- `run-room-sim.ts`: the driver (`--room <id> [--dry-run]`, `--print-spec`).
  Choreography, HTTP transport, signing, capture normalization, pure scoring
  and the results writer. The run loop takes an injectable transport so the
  tests drive the real choreography with a scripted bot.
- `rooms-spec.ts`: builds the room spec from the homepage module at runtime;
  `forbiddenHits` runs the homepage rules over first-person spans only.
- `first-person-claims.ts`: first-person span extraction for the
  forbidden-claim sweep (markers, negations, subject switches, todo and quote
  masking) with its documented blind spots.
- `room-facts.ts`: hand-written key facts and `FACT_PATTERNS` per room.
- `mock-blooio-provider.ts`: mock Blooio API for the gateway's outbound sends;
  records every request to a JSONL outbox, returns receipts, and serves
  `GET /_capture` in the driver's `OUTBOUND_CAPTURE` shape.
- `gateway-fetch-tap.preload.ts`: `bun --preload` for the webhook gateway
  process; redirects `https://api.blooio.com` to the mock provider (the
  adapter hardcodes the host, so this is the only way to run it offline
  without source changes).
- `run-room-sim.test.ts`: deterministic offline tests for the tool itself.
- `results/` (gitignored): `<room>.json`, `<room>.md`, `blooio-outbox.jsonl`.

## Env contract

Read by `run-room-sim.ts` at execution time. `--dry-run` and `--print-spec`
need none of it and make no network calls.

| Variable | Meaning |
| --- | --- |
| `BASE_URL` | required. Webhook endpoint the synthetic Blooio deliveries are POSTed to, e.g. `http://127.0.0.1:48803/api/eliza-app/webhook/blooio` (through the cloud API) or `http://127.0.0.1:3002/webhook/eliza-app/blooio` (straight at the gateway). |
| `SIGNING` | how to sign `x-blooio-signature`: `env:<VAR>` (HMAC secret read from that env var; header `t=<unix>,v1=<hex hmac-sha256 of "<t>.<body>">`, the shape `_forward.ts` and the gateway adapter verify), `cmd:<shell template>` (run via `sh -c` with the raw body in `$BODY`; stdout is the header), `none`/unset (no header), anything else is used directly as the secret. |
| `OUTBOUND_CAPTURE` | required. Where Eliza's outbound sends land: an http(s) URL whose GET returns a JSON array (or `{messages:[...]}`), or a file path (JSON array or JSONL). Entries carry text under `text|body|message` and a chat id under `chat_id|chatId|chat|to`. Entries without a chat id are ignored and counted (the DM and group streams must be distinguishable or the scoring is unsound); entries with `direction:"inbound"` or whose `sender|from` is one of the run's synthetic human handles are ignored, so only Eliza outputs are scored. Invalid payload/JSONL/message-send JSON is a harness error rather than silence, and common credential forms are redacted before text reaches logs or result artifacts. |
| `LINK_CODE_REGEX` | optional override (first capture group = code) for parsing the link code out of the `/group` DM reply. Default matches the product command `Eliza link <8 chars of 2-9A-HJ-NP-Z>`. |
| `WAIT_MS` | bounded wait per expected Eliza point (default 45000). |
| `POLL_MS` | capture poll interval (default 1500). |
| `PACE_MS` | pacing between human lines (default 1200). |
| `SILENCE_MS` | no-send window for the pre-link probe and after each human line the script does not follow with an Eliza step (default 8000). |
| `UNSOLICITED_MAX` | max tolerated unsolicited group sends across silent windows plus the trailing sweep (default 2). |
| `FACTS_MIN` | min distinct key facts across non-echo replies (default 2, floor 1). |
| `MIN_RESPONSES` | min expected points with at least one reply (default `ceil(points/2)`, floor 1). |
| `RUN_TAG` | optional suffix for the synthetic chat ids (`chat_sim_<room>_<tag>`) so a re-run against a stack whose DB persisted an earlier binding gets a fresh, unlinked group. Always set it when re-running against a stack you did not `--reset`. |
| `OWNER_HANDLE` | owner phone (default `+15550000001`). |
| `ELIZA_HANDLE` | Eliza's receiving number placed in `recipient` and `channel_address` (default `+15550009999`). |

Exit codes: `0` PASS, `1` FAIL, `2` harness error (bad env, unreachable
stack, no `/group` reply, no parseable link code). A harness error is not a
verdict: fix the stack and re-run.

Helper env: the mock provider reads `PORT` (default 48810) and
`ROOM_SIM_OUTBOX` (default `results/blooio-outbox.jsonl`); the preload reads
`ROOM_SIM_BLOOIO_MOCK_URL` (default `http://127.0.0.1:48810`).

## Running one room against the local mock stack

Four processes. Ports below are the conventions used for the proof runs;
change them consistently. The stack needs a real model key for the shared
runtime (Cerebras is the default text provider, OpenRouter the backup; put
`CEREBRAS_API_KEY` or `OPENROUTER_API_KEY` in `packages/cloud/shared/.env.local`
or export it). The gateway always verifies the Blooio webhook signature, so
pick one secret and hand it to both the gateway and the driver.

```bash
cd /path/to/eliza
export GATEWAY_BOOTSTRAP_SECRET=local-gateway-bootstrap        # API + gateway must agree
export ELIZA_APP_BLOOIO_WEBHOOK_SECRET=local-blooio-secret     # gateway + driver must agree

# 1. Cloud API stack (PGlite + mock redis) on 48803, forwarding Blooio
#    webhooks to the gateway below. --reset wipes bindings from earlier runs.
ELIZA_APP_WEBHOOK_GATEWAY_URL=http://127.0.0.1:3002 \
  bun run cloud:mock:fresh -- --port-api 48803 --no-frontend

# 2. Mock Blooio provider (records outbound sends, serves /_capture) on 48810.
bun packages/cloud/scripts/group-room-sim/mock-blooio-provider.ts

# 3. Webhook gateway on 3002 with api.blooio.com redirected to the mock.
ELIZA_CLOUD_URL=http://127.0.0.1:48803 PORT=3002 MOCK_REDIS=1 \
ELIZA_APP_BLOOIO_API_KEY=mock ELIZA_APP_BLOOIO_PHONE_NUMBER=+15550009999 \
  bun --preload ./packages/cloud/scripts/group-room-sim/gateway-fetch-tap.preload.ts \
  packages/cloud/services/gateway-webhook/src/index.ts

# 4. One room.
BASE_URL=http://127.0.0.1:48803/api/eliza-app/webhook/blooio \
SIGNING=env:ELIZA_APP_BLOOIO_WEBHOOK_SECRET \
OUTBOUND_CAPTURE=http://127.0.0.1:48810/_capture \
RUN_TAG=$(date +%H%M%S) \
  bun run cloud:group-room-sim -- --room friends
```

Notes on the wiring:

- The cloud API only validates the Blooio signature itself when
  `ELIZA_APP_BLOOIO_WEBHOOK_SECRET` reaches the Worker (it is not an
  `.env.example` key, so it must be in `packages/cloud/shared/.env.local`);
  otherwise it logs a skip outside production and forwards the request
  unchanged. The gateway verifies it regardless, so `SIGNING` is never
  optional on this path. `ELIZA_APP_WEBHOOK_GATEWAY_URL` and
  `GATEWAY_BOOTSTRAP_SECRET` are `.env.example` keys, so shell exports reach
  the Worker.
- `bun --preload` wants a `./`-prefixed or absolute path.
- The stack DB persists group bindings. A group chat id bound to one owner
  refuses `Eliza link` from another, so either `cloud:mock:fresh` or a fresh
  `RUN_TAG` per run.
- Do not share the stack with other runs: the silence windows attribute every
  group send in the capture to the room being scored.

`--dry-run` prints the plan (handles, chat ids, ambient decision, expected
points, silent windows, allowed claim categories, fact labels) and exits 0
without touching the network; `--print-spec` dumps the whole derived spec
plus the hand-written facts for review.

## Reading results/<room>.md

```
- Verdict: **PASS**
- Ambient mode: on
- Expected Eliza points responded: 5/6
- Pre-link probe sends: 0 (must be 0)
- Unsolicited sends (silent windows + trailing): 1 (max 2)
- Echoed-human outputs: 0 (must be 0)
- Distinct key facts referenced (non-echo replies): 5 (min 2): arrivals meet ~10:20; ...
- Forbidden-claim hits (incl. acks): none
```

Then the transcript in order. `**Name:** ...` lines are the synthetic humans
(`You` is the owner). `**Eliza:**` lines are what actually came back; a
trailing `_[...]_` note marks `UNSOLICITED` (arrived in a silent window or
the trailing sweep), `ECHO of: "..."` (near-copy of a human line; scored
zero), `facts: ...` (fact labels credited) and `FORBIDDEN: ...` (claim
categories tripped inside a first-person span). `_(silent: expected speaking point at position N)_`
means the script had Eliza speak there and nothing arrived inside `WAIT_MS`.
The attachment steps (positions 20 in four rooms: place, task list, handoff,
itinerary) follow an Eliza line rather than a human one, so a
reply-per-human Eliza leaves exactly those silent; `5/6` is the normal
shape. The `## Assertions` block at the end is the same JSON the run prints
to stdout and writes to `<room>.json` (which also carries every scored step).

Bounded-timing caveat: capture entries carry no provider timestamps, so a
reply that lands after its `SILENCE_MS` window closes is attributed to the
next poll. The defaults are long enough that a reply-to-everything bot still
accumulates far more than `UNSOLICITED_MAX`; shrink the windows only for
plumbing smoke tests.

## Checks for the tool itself

```bash
bun test packages/cloud/scripts/group-room-sim/run-room-sim.test.ts
bunx @biomejs/biome check packages/cloud/scripts/group-room-sim
node_modules/.bin/tsc --noEmit --ignoreConfig --strict --target ES2022 --module ESNext \
  --moduleResolution bundler --esModuleInterop --skipLibCheck --types node,bun-types \
  packages/cloud/scripts/group-room-sim/*.ts
bun run cloud:group-room-sim -- --room household --dry-run
```

The test file is discovered automatically by the `test:cloud` lane
(`packages/cloud/scripts/**`) and by `test:scripts`; it needs no network and
finishes in under a second.
