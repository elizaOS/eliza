/**
 * `instruct_dm_only` delivery adapter.
 *
 * Used when no eligible channel can collect the sensitive value safely in the
 * current channel and no link delivery is permitted (public secrets request,
 * no cloud, no tunnel, public source). The adapter does NOT itself surface
 * text to the user — the calling action emits the instruction via its
 * own callback path. This adapter only signals "instructed, no actionable
 * link or form" so the dispatch pipeline can mark the request as delivered
 * without producing a URL or rendering an inline form.
 */
import type { SensitiveRequestDeliveryAdapter } from "@elizaos/core";
export declare const instructDmOnlySensitiveRequestAdapter: SensitiveRequestDeliveryAdapter;
//# sourceMappingURL=instruct-dm-only-adapter.d.ts.map