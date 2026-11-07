import { expect, test } from "vitest";
import { removeAckReactionAfterReply } from "../src/utils/channel-utils";

test("acknowledgement rejection reaches the teardown error hook", async () => {
	const error = new Error("ack transport failed");
	const errors: unknown[] = [];
	let removals = 0;
	removeAckReactionAfterReply({
		removeAfterReply: true,
		ackReactionPromise: Promise.reject(error),
		ackReactionValue: "seen",
		remove: async () => {
			removals += 1;
		},
		onError: (value) => {
			errors.push(value);
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(errors).toEqual([error]);
	expect(removals).toBe(0);
});
