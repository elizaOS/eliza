import fsp from "node:fs/promises";
import {
	writeJsonAtomic,
	writeJsonAtomicSync,
} from "../../src/utils/atomic-json.ts";

const [file, writer, mode, boundary] = process.argv.slice(2);
if (!file || !writer || !mode)
	throw new Error("Missing writer fixture arguments");

if (boundary) {
	const rename = fsp.rename;
	fsp.rename = async (source, destination) => {
		if (boundary === "after-rename") await rename(source, destination);
		process.stdout.write(`${boundary}\n`);
		// The parent kills this process at the selected filesystem boundary.
		setInterval(() => {}, 1_000);
		await new Promise<void>(() => {});
	};
}

for (let revision = 0; revision < (boundary ? 1 : 30); revision++) {
	const value = { writer, revision, payload: writer.repeat(16_384) };
	if (mode === "sync") writeJsonAtomicSync(file, value);
	else await writeJsonAtomic(file, value);
}
