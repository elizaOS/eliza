/** Node SHA-1 binding for persisted deterministic UUIDs, importable without the runtime barrel. */
import { createHash } from "node:crypto";
import type { UUID } from "../types/primitives.js";
import { uuidFromString } from "./uuid.js";

/** Returns the persisted deterministic identity using the Node SHA-1 implementation. */
export function stringToUuid(target: string | number): UUID {
	return uuidFromString(target, (input) =>
		createHash("sha1").update(input).digest(),
	);
}
