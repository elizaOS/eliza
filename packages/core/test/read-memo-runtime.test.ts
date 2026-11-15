/** Real room reads and writes through the runtime and its SQLite adapter. */
import { expect, it, vi } from "vitest";
import { ChannelType } from "../src/types/primitives";
import { stringToUuid } from "../src/utils/string-to-uuid.js";
import { createInitializedRuntime } from "./initialized-runtime";

it("bounds cached room reads by elapsed time despite wall clock rollback", async () => {
	const runtime = await createInitializedRuntime({
		character: { name: "Room memo expiry", bio: [] },
		logLevel: "fatal",
	});
	const roomId = stringToUuid(`${runtime.agentId}-memo-room`);
	const room = {
		id: roomId,
		name: "Cached",
		agentId: runtime.agentId,
		source: "test",
		type: ChannelType.GROUP,
	};
	await runtime.createRooms([room]);

	const now = Date.now();
	const wallClock = vi.spyOn(Date, "now").mockReturnValue(now);
	const elapsed = vi.spyOn(performance, "now").mockReturnValue(10_000);
	const read = vi.spyOn(runtime.adapter, "getRoomsByIds");
	try {
		const results = await Promise.all([
			runtime.getRoom(roomId),
			runtime.getRoom(roomId),
		]);
		expect(results.map((result) => result?.name)).toEqual(["Cached", "Cached"]);
		expect(read).toHaveBeenCalledTimes(1);

		// A write through the adapter represents an external writer that cannot
		// invalidate this runtime's process-local memo.
		await runtime.adapter.upsertRooms([{ ...room, name: "Updated" }]);
		expect((await runtime.getRoomsByIds([roomId]))[0]?.name).toBe("Updated");
		wallClock.mockReturnValue(now - 60_000);
		elapsed.mockReturnValue(10_999);
		expect((await runtime.getRoom(roomId))?.name).toBe("Cached");
		elapsed.mockReturnValue(11_000);
		expect((await runtime.getRoom(roomId))?.name).toBe("Updated");

		await runtime.upsertRooms([{ ...room, name: "Local write" }]);
		expect((await runtime.getRoom(roomId))?.name).toBe("Local write");
	} finally {
		read.mockRestore();
		wallClock.mockRestore();
		elapsed.mockRestore();
	}
});
