/**
 * Google Meet speaker attribution — vote-and-lock DOM correlation. Ported from
 * Vexa speaker-identity.ts (Apache-2.0).
 *
 * Google Meet assigns each participant a fixed audio track (media element) for
 * the meeting's duration. We discover the track→name mapping by correlating
 * audio activity with the DOM speaking indicator: when audio arrives on track N
 * and exactly one participant is visibly speaking, that's a vote for track N =
 * that name. After 2 votes at ≥70% agreement the mapping LOCKS permanently.
 * One-name-per-track / one-track-per-name is enforced throughout. Roster changes
 * (participant left) invalidate that track's mapping. A 15s fallback attributes
 * an un-mapped speaking track by participant order when correlation stalls.
 */

import { logger } from "@elizaos/core";
import type { Page } from "playwright-core";
import type { MeetingAudioSink } from "../../types.js";
import { googleNameSelectors, googleSpeakingIndicators } from "./selectors.js";

const LOCK_THRESHOLD = 2;
const LOCK_RATIO = 0.7;
const ROSTER_POLL_MS = 3_000;
/** Min interval between browser attribution queries per track. */
const ATTRIBUTION_THROTTLE_MS = 800;
/** Fallback attribution kicks in after this long with a speaking, unmapped track. */
const FALLBACK_MS = 15_000;

interface RosterEntry {
  id: string;
  displayName: string;
}

/**
 * Pure vote-and-lock table. Extracted so the state machine is unit-testable
 * with synthetic observations (no browser/page needed).
 */
export class VoteLockTable {
  private readonly votes = new Map<number, Map<string, number>>();
  private readonly locked = new Map<number, string>();

  /** True when `name` is locked to a track other than `excludeTrack`. */
  isNameTaken(name: string, excludeTrack?: number): boolean {
    for (const [track, lockedName] of this.locked) {
      if (track !== excludeTrack && lockedName === name) return true;
    }
    return false;
  }

  getLocked(track: number): string | null {
    return this.locked.get(track) ?? null;
  }

  isLocked(track: number): boolean {
    return this.locked.has(track);
  }

  /**
   * Record a vote for `track` = `name` with `weight` (1.0 exclusive, 0.5
   * overlapping). Returns the newly locked name if this vote triggered a lock,
   * else null. Ignores votes for already-locked tracks or taken names.
   */
  recordVote(track: number, name: string, weight = 1.0): string | null {
    if (this.locked.has(track)) return null;
    if (this.isNameTaken(name, track)) return null;

    let byName = this.votes.get(track);
    if (!byName) {
      byName = new Map();
      this.votes.set(track, byName);
    }
    byName.set(name, (byName.get(name) ?? 0) + weight);

    const total = [...byName.values()].reduce((a, b) => a + b, 0);
    const [topName, topVotes] = [...byName.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0];
    if (
      topVotes >= LOCK_THRESHOLD &&
      topVotes / total >= LOCK_RATIO &&
      !this.isNameTaken(topName, track)
    ) {
      this.locked.set(track, topName);
      return topName;
    }
    return null;
  }

  /** Best current guess for `track`: locked name, else top unclaimed vote. */
  bestGuess(track: number): string | null {
    const locked = this.locked.get(track);
    if (locked) return locked;
    const byName = this.votes.get(track);
    if (!byName) return null;
    for (const [name] of [...byName.entries()].sort((a, b) => b[1] - a[1])) {
      if (!this.isNameTaken(name, track)) return name;
    }
    return null;
  }

  /** Drop a track's votes + lock (participant left / roster change). */
  invalidate(track: number): void {
    this.votes.delete(track);
    this.locked.delete(track);
  }

  clear(): void {
    this.votes.clear();
    this.locked.clear();
  }
}

/** Read participant names + who's currently speaking from the Meet DOM. */
async function queryMeetState(
  page: Page,
  botName: string,
): Promise<{ names: string[]; speaking: string[] } | null> {
  try {
    return await page.evaluate(
      ({ nameSelectors, speakingSelectors, self }) => {
        const isJunk = (name: string): boolean =>
          /^Google Participant \(/.test(name) ||
          /spaces\//.test(name) ||
          /devices\//.test(name);
        const junkPhrases = [
          "let participants",
          "send messages",
          "turn on captions",
        ];
        const selfLower = self.toLowerCase();

        const collect = (selectors: string[]): string[] => {
          const out = new Set<string>();
          for (const sel of selectors) {
            for (const el of Array.from(document.querySelectorAll(sel))) {
              const text = (el.textContent || "").trim();
              if (!text) continue;
              const lower = text.toLowerCase();
              if (lower.includes(selfLower) || selfLower.includes(lower))
                continue;
              if (junkPhrases.some((p) => lower.includes(p))) continue;
              if (isJunk(text)) continue;
              if (text.length > 60) continue;
              out.add(text);
            }
          }
          return [...out];
        };

        const names = collect(nameSelectors);
        // A speaking tile: an ancestor participant container whose subtree has a
        // speaking indicator. We approximate by reading the name inside any
        // element matching a speaking indicator's closest labelled ancestor.
        const speaking = new Set<string>();
        for (const sel of speakingSelectors) {
          for (const ind of Array.from(document.querySelectorAll(sel))) {
            let node: Element | null = ind;
            while (node && node !== document.body) {
              const labelled = node.querySelector(
                "[data-self-name], span.notranslate",
              );
              const text = (labelled?.textContent || "").trim();
              if (text && text.length <= 60) {
                const lower = text.toLowerCase();
                if (!lower.includes(selfLower) && !selfLower.includes(lower))
                  speaking.add(text);
                break;
              }
              node = node.parentElement;
            }
          }
        }
        return { names, speaking: [...speaking] };
      },
      {
        nameSelectors: [...googleNameSelectors],
        speakingSelectors: [...googleSpeakingIndicators],
        self: botName,
      },
    );
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "[GoogleSpeakerIdentity] DOM query failed",
    );
    return null;
  }
}

/**
 * Drives vote-and-lock attribution + roster events into a `MeetingAudioSink`.
 * `observeAudio(streamKey)` is called by the audio-capture path per accepted
 * chunk; roster polling runs on its own timer. `stop()` clears timers.
 */
export class GoogleSpeakerIdentity {
  private readonly table = new VoteLockTable();
  private readonly lastAudioMs = new Map<number, number>();
  private readonly lastAttributionMs = new Map<number, number>();
  private readonly announced = new Set<string>();
  private roster = new Map<string, RosterEntry>();
  private rosterTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();

  constructor(
    private readonly page: Page,
    private readonly sink: MeetingAudioSink,
    private readonly botName: string,
  ) {}

  start(): void {
    this.rosterTimer = setInterval(() => {
      this.pollRoster().catch((err) =>
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "[GoogleSpeakerIdentity] roster poll failed",
        ),
      );
    }, ROSTER_POLL_MS);
  }

  stop(): void {
    if (this.rosterTimer) clearInterval(this.rosterTimer);
    this.rosterTimer = null;
  }

  /** Called per accepted audio chunk for `streamKey` (stream index as string). */
  async observeAudio(streamKey: string): Promise<void> {
    const track = Number(streamKey);
    if (!Number.isInteger(track)) return;
    this.lastAudioMs.set(track, Date.now());
    if (this.table.isLocked(track)) return;

    const now = Date.now();
    const last = this.lastAttributionMs.get(track) ?? 0;
    if (now - last < ATTRIBUTION_THROTTLE_MS) return;
    this.lastAttributionMs.set(track, now);

    const state = await queryMeetState(this.page, this.botName);
    if (!state) return;
    const { speaking } = state;

    if (speaking.length === 1) {
      this.vote(track, speaking[0], 1.0);
    } else if (speaking.length === 2) {
      for (const name of speaking) this.vote(track, name, 0.5);
    } else if (now - this.startedAt > FALLBACK_MS) {
      // Fallback: attribute by participant order when correlation stalls.
      this.fallbackAttribute(track, state.names);
    }
  }

  private vote(track: number, name: string, weight: number): void {
    const lockedNow = this.table.recordVote(track, name, weight);
    const resolved = lockedNow ?? this.table.bestGuess(track);
    if (resolved) this.sink.setSpeakerName(String(track), resolved);
    if (lockedNow)
      logger.info(
        `[GoogleSpeakerIdentity] track ${track} LOCKED → "${lockedNow}"`,
      );
  }

  private fallbackAttribute(track: number, names: string[]): void {
    // Pick the first roster name not already taken by another track.
    for (const name of names) {
      if (!this.table.isNameTaken(name, track)) {
        this.vote(track, name, 1.0);
        return;
      }
    }
  }

  private async pollRoster(): Promise<void> {
    const state = await queryMeetState(this.page, this.botName);
    if (!state) return;
    const next = new Map<string, RosterEntry>();
    for (const displayName of state.names) {
      const id = displayName; // stable within a session; Meet has no exposed id here
      next.set(id, { id, displayName });
    }

    for (const [id, entry] of next) {
      if (!this.roster.has(id) && !this.announced.has(id)) {
        this.announced.add(id);
        this.sink.participantJoined({ id, displayName: entry.displayName });
      }
    }
    const nowMs = Date.now() - this.startedAt;
    for (const [id] of this.roster) {
      if (!next.has(id)) {
        this.sink.participantLeft(id, nowMs);
        // A departed participant frees their track mapping for reuse.
        for (const track of this.tracksNamed(id)) this.table.invalidate(track);
      }
    }
    this.roster = next;
  }

  private tracksNamed(name: string): number[] {
    const out: number[] = [];
    for (const track of this.lastAudioMs.keys()) {
      if (this.table.getLocked(track) === name) out.push(track);
    }
    return out;
  }
}
