import fs from "node:fs";
import path from "node:path";

const platformNames: Record<string, string> = {
	darwin: "macos",
	linux: "linux",
	win32: "windows",
};

const archNames: Record<string, string> = {
	arm64: "arm64",
	x64: "x64",
};

const envName = process.env.ELECTROBUN_ENV?.trim() || "dev";
const osName = process.env.ELECTROBUN_OS?.trim() || platformNames[process.platform];
const archName = process.env.ELECTROBUN_ARCH?.trim() || archNames[process.arch];

if (!osName || !archName) {
	throw new Error(
		`Unsupported Electrobun build target: ${process.platform}/${process.arch}`,
	);
}

fs.mkdirSync(path.join("build", `${envName}-${osName}-${archName}`), {
	recursive: true,
});
