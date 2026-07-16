/**
 * Composes the message-service regression suites for changes to the monolithic
 * DefaultMessageService module (`services/message.ts`). The changed-file
 * coverage gate runs only tests present in a PR diff, so this lane keeps such
 * changes attached to the existing behavioral matrix until the message service
 * is decomposed into independently covered modules — the mirror of
 * `runtime-regression-lane.test.ts` for the other core monolith.
 *
 * Added for #16230 (scoping the visible chat stream to the top-level reply):
 * `message.shortcut-gate.test` exercises the shortcut path's streaming-
 * suppression wrap; the surrounding turn/voice suites supply the rest of the
 * line coverage the gate's per-file floor requires. Only suites that share one
 * process cleanly are composed here — suites that write trajectory to disk or
 * install leaky module-level mocks (stress-compaction, credit-exhaustion,
 * attachment SSRF) stay in their own isolated files.
 */
import "../services/message.mute-drop.test";
import "../services/message.shortcut-gate.test";
import "../services/message.voice-gate.test";
import "./message-answer-clobber-rescue.test";
import "./message-failure-reply.test";
import "./message-routing-live-regression.test";
import "./message-runtime-stage1.test";
import "./planner-happy-path.test";
