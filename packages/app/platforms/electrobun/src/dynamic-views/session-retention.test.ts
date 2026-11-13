import { expect, test } from "vitest";
import { buildDynamicViewRpcHandlers } from "../rpc-handler-slices";
import {
	KIOSK_VIEW_EVENT_MESSAGE,
	KioskCanvas,
	type KioskViewEvent,
} from "./kiosk-canvas";
import { DynamicViewRegistry } from "./registry";
import { DynamicViewSessionManager } from "./session-manager";

const viewId = "agent.run.trace.demo";

async function setup(maxSessionHistory?: number) {
	const events: KioskViewEvent[] = [];
	let rejectInitialEvent = false;
	const registry = new DynamicViewRegistry();
	const canvas = new KioskCanvas((name, payload) => {
		expect(name).toBe(KIOSK_VIEW_EVENT_MESSAGE);
		const event = payload as KioskViewEvent;
		if (event.kind === "a2ui" && rejectInitialEvent) {
			rejectInitialEvent = false;
			throw new Error("Renderer transport rejected initial state");
		}
		events.push(event);
	});
	const sessions = new DynamicViewSessionManager({
		registry,
		canvas,
		maxSessionHistory,
	});
	const rpc = buildDynamicViewRpcHandlers({ registry, sessions });
	await rpc.dynamicViewRegister({
		manifest: {
			id: viewId,
			title: "Agent Run Trace Demo",
			source: "developer",
			entrypoint: "./demo/agent-run-trace.html",
			placement: "floating",
		},
	});
	return {
		rpc,
		events,
		open: () => rpc.dynamicViewOpen({ viewId }),
		rejectNextInitialEvent() {
			rejectInitialEvent = true;
		},
	};
}

test("an open kiosk session stays addressable beyond the default history target", async () => {
	const { rpc, events, open } = await setup();
	const first = await open();
	for (let index = 0; index < 200; index++) await open();

	expect(events.filter((event) => event.kind === "mount")).toHaveLength(201);
	const firstWindow = first.canvasWindowId;
	if (!firstWindow) throw new Error("The first open lacks a canvas receipt");
	const close = { sessionId: first.sessionId };
	const snapshot = await rpc.dynamicViewSessions();
	await expect(
		rpc.dynamicViewPush({
			...close,
			event: "trace.event",
			payload: { sequence: 1 },
		}),
	).resolves.toEqual({ ok: true });
	const closed = await rpc.dynamicViewClose(close);
	expect(closed).toMatchObject({
		status: "closed",
		canvasWindowId: firstWindow,
	});
	expect(await rpc.dynamicViewClose(close)).toEqual(closed);
	expect(snapshot.sessions).toHaveLength(201);
	expect(
		snapshot.sessions.find((session) => session.sessionId === first.sessionId),
	).toMatchObject({ status: "open", canvasWindowId: firstWindow });
	expect(
		events
			.filter((event) => event.windowId === firstWindow)
			.map((event) => event.kind),
	).toEqual(["mount", "a2ui", "a2ui", "unmount"]);
});

test("history pruning waits for close receipts and trims multiple retired sessions", async () => {
	const { rpc, events, open, rejectNextInitialEvent } = await setup(2);
	rejectNextInitialEvent();
	await expect(open()).rejects.toMatchObject({
		code: "DYNAMIC_VIEW_OPEN_FAILED",
	});
	const [failed] = (await rpc.dynamicViewSessions()).sessions;
	if (!failed?.canvasWindowId)
		throw new Error("The failed open lacks a mounted canvas");
	expect(failed.status).toBe("error");
	const second = await open();
	const third = await open();
	const fourth = await open();

	for (const session of [failed, second, third]) {
		expect(
			await rpc.dynamicViewClose({ sessionId: session.sessionId }),
		).toMatchObject({
			status: "closed",
			canvasWindowId: session.canvasWindowId,
		});
	}
	const fifth = await open();
	const { sessions } = await rpc.dynamicViewSessions();
	expect(
		sessions.map(({ sessionId, status }) => ({ sessionId, status })),
	).toEqual([
		{ sessionId: fourth.sessionId, status: "open" },
		{ sessionId: fifth.sessionId, status: "open" },
	]);
	for (const session of [failed, second, third]) {
		await expect(
			rpc.dynamicViewClose({ sessionId: session.sessionId }),
		).rejects.toMatchObject({ code: "DYNAMIC_VIEW_SESSION_NOT_FOUND" });
	}
	expect(
		events
			.filter((event) => event.kind === "unmount")
			.map((event) => event.windowId),
	).toEqual([
		failed.canvasWindowId,
		second.canvasWindowId,
		third.canvasWindowId,
	]);
});
