/**
 * Owns native-resource cleanup for the direct ASR smoke command. Transcript
 * assertions throw through this boundary so Bun cannot bypass FFI teardown by
 * exiting from inside the active Metal region.
 */
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "./ffi-bindings";

export class AsrSmokeFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AsrSmokeFailure";
	}
}

export function failAsrSmoke(message: string): never {
	throw new AsrSmokeFailure(message);
}

export function runAsrSmokeWithCleanup(args: {
	ffi: ElizaInferenceFfi;
	bundleDir: string;
	run: (ctx: ElizaInferenceContextHandle) => void;
}): void {
	let ctx: ElizaInferenceContextHandle | undefined;
	let acquired = false;
	try {
		ctx = args.ffi.create(args.bundleDir);
		args.ffi.mmapAcquire(ctx, "asr");
		acquired = true;
		args.run(ctx);
	} finally {
		try {
			if (ctx !== undefined && acquired) args.ffi.mmapEvict(ctx, "asr");
		} finally {
			try {
				if (ctx !== undefined) args.ffi.destroy(ctx);
			} finally {
				args.ffi.close();
			}
		}
	}
}
