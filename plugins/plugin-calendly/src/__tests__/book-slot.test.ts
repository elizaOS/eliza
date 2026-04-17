/**
 * Integration-style tests for the three Calendly actions. A minimal
 * ICalendlyService stub is injected into a fake runtime via `getService`.
 * This lets us drive every handler code path without touching the network.
 */

import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { bookSlotAction } from "../actions/book-slot.js";
import { cancelBookingAction } from "../actions/cancel-booking.js";
import { listEventTypesAction } from "../actions/list-event-types.js";
import {
	CALENDLY_SERVICE_TYPE,
	type CalendlyEventType,
	type ICalendlyService,
} from "../types.js";

/**
 * Vitest `vi.fn()` returns an untyped `Mock`, which will not structurally
 * match `ICalendlyService` method signatures. Using `vi.fn<Signature>()`
 * binds each mock to its call/return signature so the resulting stub is
 * directly assignable to `ICalendlyService`.
 */
interface StubService extends ICalendlyService {
	isConnected: ReturnType<typeof vi.fn<() => boolean>>;
	listEventTypes: ReturnType<typeof vi.fn<ICalendlyService["listEventTypes"]>>;
	getBookingUrl: ReturnType<typeof vi.fn<ICalendlyService["getBookingUrl"]>>;
	getScheduledEvent: ReturnType<
		typeof vi.fn<ICalendlyService["getScheduledEvent"]>
	>;
	getInvitee: ReturnType<typeof vi.fn<ICalendlyService["getInvitee"]>>;
	cancelBooking: ReturnType<typeof vi.fn<ICalendlyService["cancelBooking"]>>;
}

function buildStub(connected: boolean): StubService {
	return {
		isConnected: vi.fn<() => boolean>(() => connected),
		listEventTypes: vi.fn<ICalendlyService["listEventTypes"]>(),
		getBookingUrl: vi.fn<ICalendlyService["getBookingUrl"]>(),
		getScheduledEvent: vi.fn<ICalendlyService["getScheduledEvent"]>(),
		getInvitee: vi.fn<ICalendlyService["getInvitee"]>(),
		cancelBooking: vi.fn<ICalendlyService["cancelBooking"]>(),
	};
}

function buildRuntime(service: StubService | null): IAgentRuntime {
	return {
		agentId: "test-agent",
		getService: (type: string) =>
			type === CALENDLY_SERVICE_TYPE ? service : null,
		getSetting: () => undefined,
	} as unknown as IAgentRuntime;
}

function buildMessage(text: string): Memory {
	return {
		id: "m",
		entityId: "e",
		roomId: "r",
		content: { text },
	} as unknown as Memory;
}

async function runHandler(
	action: Action,
	runtime: IAgentRuntime,
	message: Memory,
	options: Record<string, unknown> = {},
): Promise<unknown> {
	const callback = vi.fn(async () => []);
	return action.handler(runtime, message, undefined, options as never, callback);
}

const EVENT_TYPES: CalendlyEventType[] = [
	{
		uri: "https://api.calendly.com/event_types/et-15",
		name: "15 Minute",
		active: true,
		slug: "15min",
		scheduling_url: "https://calendly.com/me/15min",
		duration: 15,
		kind: "solo",
		type: "StandardEventType",
		description_plain: null,
	},
	{
		uri: "https://api.calendly.com/event_types/et-30",
		name: "30 Minute",
		active: true,
		slug: "30min",
		scheduling_url: "https://calendly.com/me/30min",
		duration: 30,
		kind: "solo",
		type: "StandardEventType",
		description_plain: null,
	},
];

describe("BOOK_CALENDLY_SLOT", () => {
	it("echoes back a third-party Calendly URL without calling the service", async () => {
		const stub = buildStub(true);
		const runtime = buildRuntime(stub);
		const result = (await runHandler(
			bookSlotAction,
			runtime,
			buildMessage(
				"Book me an intro call on Alex's Calendly: https://calendly.com/alex/intro",
			),
		)) as { success: true; data: { bookingUrl: string; source: string } };
		expect(result.success).toBe(true);
		expect(result.data.bookingUrl).toBe("https://calendly.com/alex/intro");
		expect(result.data.source).toBe("third-party");
		expect(stub.getBookingUrl).not.toHaveBeenCalled();
	});

	it("resolves own event with a duration hint extracted from text", async () => {
		const stub = buildStub(true);
		stub.getBookingUrl.mockImplementation(async (query?: { durationMinutes?: number }) => {
			const match = EVENT_TYPES.find((e) => e.duration === query?.durationMinutes);
			return match?.scheduling_url ?? null;
		});
		const runtime = buildRuntime(stub);
		const result = (await runHandler(
			bookSlotAction,
			runtime,
			buildMessage("Give me a 30 minute slot please"),
		)) as { success: true; data: { bookingUrl: string; source: string } };
		expect(result.success).toBe(true);
		expect(result.data.bookingUrl).toBe("https://calendly.com/me/30min");
		expect(result.data.source).toBe("own-event");
		expect(stub.getBookingUrl).toHaveBeenCalledWith({
			durationMinutes: 30,
			slug: undefined,
		});
	});

	it("passes durationMinutes from options through when text has no hint", async () => {
		const stub = buildStub(true);
		stub.getBookingUrl.mockResolvedValue("https://calendly.com/me/15min");
		const runtime = buildRuntime(stub);
		const result = (await runHandler(
			bookSlotAction,
			runtime,
			buildMessage("book me"),
			{ durationMinutes: 15 },
		)) as { success: true; data: { bookingUrl: string } };
		expect(result.success).toBe(true);
		expect(result.data.bookingUrl).toBe("https://calendly.com/me/15min");
		expect(stub.getBookingUrl).toHaveBeenCalledWith({
			durationMinutes: 15,
			slug: undefined,
		});
	});

	it("passes slug option through to the service", async () => {
		const stub = buildStub(true);
		stub.getBookingUrl.mockResolvedValue("https://calendly.com/me/30min");
		const runtime = buildRuntime(stub);
		const result = (await runHandler(
			bookSlotAction,
			runtime,
			buildMessage("book me"),
			{ slug: "30min" },
		)) as { success: true; data: { bookingUrl: string } };
		expect(result.success).toBe(true);
		expect(stub.getBookingUrl).toHaveBeenCalledWith({
			durationMinutes: undefined,
			slug: "30min",
		});
	});

	it("reports a graceful not-connected error when no URL and no token", async () => {
		const stub = buildStub(false);
		const runtime = buildRuntime(stub);
		const result = (await runHandler(
			bookSlotAction,
			runtime,
			buildMessage("book me a meeting"),
		)) as { success: false; error: string };
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not connected/);
		expect(stub.getBookingUrl).not.toHaveBeenCalled();
	});
});

describe("LIST_CALENDLY_EVENT_TYPES", () => {
	it("returns the service's event-type list", async () => {
		const stub = buildStub(true);
		stub.listEventTypes.mockResolvedValue(EVENT_TYPES);
		const runtime = buildRuntime(stub);
		const result = (await runHandler(
			listEventTypesAction,
			runtime,
			buildMessage("list my event types"),
		)) as { success: true; data: { eventTypes: CalendlyEventType[] } };
		expect(result.success).toBe(true);
		expect(result.data.eventTypes).toHaveLength(2);
	});
});

describe("CANCEL_CALENDLY_BOOKING", () => {
	it("cancels and extracts the UUID + reason from the message", async () => {
		const stub = buildStub(true);
		stub.cancelBooking.mockResolvedValue(undefined);
		const runtime = buildRuntime(stub);
		const result = (await runHandler(
			cancelBookingAction,
			runtime,
			buildMessage(
				"Cancel scheduled_events/11111111-2222-3333-4444-555555555555 because I need to travel",
			),
		)) as { success: true; data: { uuid: string; reason?: string } };
		expect(result.success).toBe(true);
		expect(result.data.uuid).toBe("11111111-2222-3333-4444-555555555555");
		expect(result.data.reason).toBe("I need to travel");
		expect(stub.cancelBooking).toHaveBeenCalledWith(
			"11111111-2222-3333-4444-555555555555",
			"I need to travel",
		);
	});

	it("rejects when no UUID can be extracted", async () => {
		const stub = buildStub(true);
		const runtime = buildRuntime(stub);
		const result = (await runHandler(
			cancelBookingAction,
			runtime,
			buildMessage("cancel my meeting please"),
		)) as { success: false; error: string };
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/scheduled_events/);
		expect(stub.cancelBooking).not.toHaveBeenCalled();
	});
});
