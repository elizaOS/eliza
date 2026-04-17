/**
 * @module types
 * @description Shared types for the Calendly plugin.
 *
 * These mirror the subset of the Calendly v2 REST API we consume. They are
 * intentionally narrow — we only model fields actions actually read, so the
 * contract stays honest about what the plugin promises.
 */

export const CALENDLY_SERVICE_TYPE = "calendly";

export const CalendlyActions = {
	LIST_CALENDLY_EVENT_TYPES: "LIST_CALENDLY_EVENT_TYPES",
	BOOK_CALENDLY_SLOT: "BOOK_CALENDLY_SLOT",
	CANCEL_CALENDLY_BOOKING: "CANCEL_CALENDLY_BOOKING",
} as const;

export interface CalendlyUser {
	uri: string;
	name: string;
	slug: string;
	email: string;
	scheduling_url: string;
	timezone: string;
	current_organization: string;
}

export interface CalendlyEventType {
	uri: string;
	name: string;
	active: boolean;
	slug: string;
	scheduling_url: string;
	duration: number;
	kind: string;
	type: string;
	description_plain: string | null;
}

export interface CalendlyInviteeRef {
	type: string;
	email?: string;
	name?: string;
}

export interface CalendlyScheduledEvent {
	uri: string;
	name: string;
	status: "active" | "canceled";
	start_time: string;
	end_time: string;
	event_type: string;
	invitees_counter: {
		total: number;
		active: number;
		limit: number;
	};
}

export interface CalendlyInvitee {
	uri: string;
	email: string;
	name: string;
	status: "active" | "canceled";
	event: string;
	cancel_url: string;
	reschedule_url: string;
}

export interface CalendlyListResponse<T> {
	collection: T[];
	pagination: {
		count: number;
		next_page: string | null;
		previous_page: string | null;
		next_page_token: string | null;
		previous_page_token: string | null;
	};
}

/**
 * Payload Calendly delivers to configured webhook endpoints. We only model
 * the envelope — the nested `payload` varies by event type and is inspected
 * by downstream consumers rather than this plugin.
 */
export interface CalendlyWebhookEvent {
	event:
		| "invitee.created"
		| "invitee.canceled"
		| "invitee_no_show.created"
		| "invitee_no_show.deleted"
		| "routing_form_submission.created";
	created_at: string;
	created_by: string;
	payload: Record<string, unknown>;
}

export type CalendlyActionResult<T = unknown> =
	| { success: true; data: T }
	| { success: false; error: string };

export interface BookingLinkQuery {
	/** Optional duration hint in minutes. Matched against event type durations. */
	durationMinutes?: number;
	/** Optional event slug. Exact match on `slug`. */
	slug?: string;
}

export interface ICalendlyService {
	isConnected(): boolean;
	listEventTypes(): Promise<CalendlyEventType[]>;
	getBookingUrl(query?: BookingLinkQuery): Promise<string | null>;
	getScheduledEvent(uuid: string): Promise<CalendlyScheduledEvent>;
	getInvitee(eventUuid: string, inviteeUuid: string): Promise<CalendlyInvitee>;
	cancelBooking(uuid: string, reason?: string): Promise<void>;
}
