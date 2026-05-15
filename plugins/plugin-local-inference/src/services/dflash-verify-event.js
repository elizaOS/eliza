/**
 * L1 — DFlash verify-event protocol.
 *
 * Wire format: `docs/eliza-1-dflash-events-wire.md`. The C-side
 * `llama-server` fork emits one of these on the top-level `dflashVerify`
 * field of every SSE chunk that wraps a speculative-decoding verify
 * step, when launched with `--dflash-emit-verify-events`. Today the JS
 * runtime synthesises `accept`/`reject` `VerifierStreamEvent`s from
 * each text delta; this module gives the runtime a typed parse of the
 * native record so the autotuner / voice rollback heuristic can use
 * exact accept counts, reject indices, and per-token logprobs instead.
 *
 * This module is intentionally standalone (no dependency on the older
 * `dflash-event-schema.ts` union-shape parser). Both protocols coexist
 * on the same SSE chunk; consumers wire whichever they need.
 *
 * The protocol is additive: when the binary does not emit
 * `dflashVerify`, this module's parsers return empty arrays and the
 * legacy synthesis path runs unchanged.
 */
function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}
function isNonNegativeInt(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isLogprob(value) {
    if (typeof value !== "number")
        return false;
    return Number.isFinite(value) || value === -Infinity;
}
function parseToken(value) {
    if (!value || typeof value !== "object")
        return null;
    const obj = value;
    if (!isNonNegativeInt(obj.id) || !isLogprob(obj.logprob))
        return null;
    return { id: obj.id, logprob: obj.logprob };
}
function parseTokenArray(value) {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const entry of value) {
        const parsed = parseToken(entry);
        if (!parsed)
            return null;
        out.push(parsed);
    }
    return out;
}
/**
 * Parse a JSON value into a `DflashVerifyEvent`. Returns null on any
 * shape mismatch — the caller treats parse failures as "no native event
 * present" and falls back to the legacy synthesis path.
 *
 * Accepts both snake_case (the wire format) and camelCase (already-
 * adapted by a friendly emitter) field names.
 */
export function parseDflashVerifyEvent(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const obj = raw;
    if (obj.kind !== "dflash-verify")
        return null;
    if (!isFiniteNumber(obj.ts))
        return null;
    const draftedRaw = obj.draftedTokens ?? obj.drafted_tokens;
    const drafted = parseTokenArray(draftedRaw);
    if (!drafted)
        return null;
    const acceptRaw = obj.acceptCount ?? obj.accept_count;
    if (!isNonNegativeInt(acceptRaw))
        return null;
    if (acceptRaw > drafted.length)
        return null;
    const rejectRaw = obj.rejectIndex ?? obj.reject_index;
    let rejectIndex;
    if (rejectRaw === null || rejectRaw === undefined) {
        rejectIndex = null;
    }
    else if (isNonNegativeInt(rejectRaw)) {
        rejectIndex = rejectRaw;
    }
    else {
        return null;
    }
    // Invariant: rejectIndex null iff acceptCount === drafted.length.
    if (rejectIndex === null && acceptRaw !== drafted.length)
        return null;
    if (rejectIndex !== null) {
        if (rejectIndex !== acceptRaw)
            return null;
        if (rejectIndex >= drafted.length)
            return null;
    }
    const correctionRaw = obj.correctionToken ?? obj.correction_token ?? null;
    let correction;
    if (correctionRaw === null || correctionRaw === undefined) {
        correction = null;
    }
    else {
        correction = parseToken(correctionRaw);
        if (!correction)
            return null;
    }
    if (rejectIndex === null && correction !== null)
        return null;
    if (rejectIndex !== null && correction === null)
        return null;
    const postRaw = obj.postCorrectionTokens ?? obj.post_correction_tokens ?? [];
    const post = parseTokenArray(postRaw);
    if (!post)
        return null;
    return {
        kind: "dflash-verify",
        draftedTokens: drafted,
        acceptCount: acceptRaw,
        rejectIndex,
        correctionToken: correction,
        postCorrectionTokens: post,
        ts: obj.ts,
    };
}
/**
 * Extract verify events from a parsed SSE chunk. Looks at the
 * `dflashVerify` top-level field (preferred) and the optional
 * `dflash` field (when the fork co-emits the verify event under the
 * union-shape protocol for forward compat). Returns [] when neither is
 * present.
 */
export function parseDflashVerifyEventsFromSseChunk(parsed) {
    if (!parsed || typeof parsed !== "object")
        return [];
    const out = [];
    const collect = (field) => {
        if (field === undefined || field === null)
            return;
        if (Array.isArray(field)) {
            for (const entry of field) {
                const ev = parseDflashVerifyEvent(entry);
                if (ev)
                    out.push(ev);
            }
            return;
        }
        const ev = parseDflashVerifyEvent(field);
        if (ev)
            out.push(ev);
    };
    collect(parsed.dflashVerify);
    // The verify event may also ride on the union `dflash` field when the
    // fork is in the transition window between the two shapes. Filter to
    // verify-kind only.
    const dflashField = parsed.dflash;
    if (dflashField) {
        if (Array.isArray(dflashField)) {
            for (const entry of dflashField) {
                const ev = parseDflashVerifyEvent(entry);
                if (ev)
                    out.push(ev);
            }
        }
        else {
            const ev = parseDflashVerifyEvent(dflashField);
            if (ev)
                out.push(ev);
        }
    }
    return out;
}
export function summarizeVerifyEvents(events) {
    let drafted = 0;
    let accepted = 0;
    for (const ev of events) {
        drafted += ev.draftedTokens.length;
        accepted += ev.acceptCount;
    }
    return {
        draftedTokens: drafted,
        acceptedTokens: accepted,
        rejectedTokens: drafted - accepted,
        verifySteps: events.length,
        acceptanceRate: drafted === 0 ? null : accepted / drafted,
    };
}
const L1_METRIC_PATTERNS = {
    rejected: /^llamacpp:n_drafted_rejected(?:_total)?(?:\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i,
    verify: /^llamacpp:n_verify_steps(?:_total)?(?:\{[^}]*\})?\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i,
};
/**
 * Parse the two L1 verify counters out of a Prometheus exposition body.
 * Returns `{ present: false }` (with zeros) when neither line is found.
 * Labelled samples are summed; unlabelled totals take precedence when
 * both appear (matches the convention in `llama-server-metrics.ts`).
 */
export function parseDflashVerifyMetrics(body) {
    let rejectedUnlabeled = null;
    let rejectedLabeled = 0;
    let verifyUnlabeled = null;
    let verifyLabeled = 0;
    let seen = false;
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const rej = line.match(L1_METRIC_PATTERNS.rejected);
        if (rej) {
            seen = true;
            const value = Number(rej[1]);
            if (!Number.isFinite(value))
                continue;
            const labeled = line.includes("{");
            if (labeled)
                rejectedLabeled += value;
            else
                rejectedUnlabeled = value;
            continue;
        }
        const ver = line.match(L1_METRIC_PATTERNS.verify);
        if (ver) {
            seen = true;
            const value = Number(ver[1]);
            if (!Number.isFinite(value))
                continue;
            const labeled = line.includes("{");
            if (labeled)
                verifyLabeled += value;
            else
                verifyUnlabeled = value;
        }
    }
    return {
        rejectedTokens: rejectedUnlabeled ?? rejectedLabeled,
        verifySteps: verifyUnlabeled ?? verifyLabeled,
        present: seen,
    };
}
/**
 * Compute the per-request delta of the two L1 counters across two
 * scrapes. Returns `null` when neither scrape saw the L1 counters
 * (stock build). Negative deltas (server restart between scrapes) are
 * clamped to zero.
 */
export function diffDflashVerifyMetrics(before, after) {
    if (!before.present && !after.present)
        return null;
    const rejected = clamp(after.rejectedTokens - before.rejectedTokens);
    const verify = clamp(after.verifySteps - before.verifySteps);
    return {
        rejectedTokens: rejected,
        verifySteps: verify,
        // acceptanceRate cannot be derived from these two counters alone —
        // the caller composes it with the existing `n_drafted_total` /
        // `n_drafted_accepted_total` deltas. We surface it as `null` here so
        // the caller knows to fill it in.
        acceptanceRate: null,
    };
}
function clamp(value) {
    if (!Number.isFinite(value))
        return 0;
    return value < 0 ? 0 : value;
}
/**
 * Fetch `/metrics` from a running llama-server and pull the two L1
 * counters. Returns `{present: false}` on any HTTP error so a stock
 * build (or a transient blip) does not throw inside the per-turn hot
 * path.
 */
export async function fetchDflashVerifyMetricSample(baseUrl, signal) {
    const empty = {
        rejectedTokens: 0,
        verifySteps: 0,
        present: false,
    };
    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/metrics`, {
            method: "GET",
            signal,
        });
        if (!res.ok)
            return empty;
        const body = await res.text();
        return parseDflashVerifyMetrics(body);
    }
    catch {
        return empty;
    }
}
//# sourceMappingURL=dflash-verify-event.js.map