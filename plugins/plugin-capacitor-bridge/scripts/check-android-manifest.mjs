/**
 * Android manifest guard for the Capacitor bridge native fragment.
 *
 * The package build runs this before bundling so a stray `tools:*` attribute
 * cannot reach Capacitor sync without the namespace declaration Android needs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(packageRoot, "android/src/main/AndroidManifest.xml");
const manifest = readFileSync(manifestPath, "utf8");
const manifestTag = manifest.match(/<manifest\b[^>]*>/)?.[0] ?? "";

if (!manifestTag) {
	console.error(`Missing root <manifest> tag in ${manifestPath}`);
	process.exit(1);
}

if (
	manifest.includes("tools:") &&
	!manifestTag.includes('xmlns:tools="http://schemas.android.com/tools"')
) {
	console.error(
		`Android manifest uses tools:* attributes without declaring xmlns:tools in ${manifestPath}`,
	);
	process.exit(1);
}
