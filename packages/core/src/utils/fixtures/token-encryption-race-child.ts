/** Process participant used to exercise token-key first-use initialization. */

import fs from "node:fs";
import path from "node:path";
import { resolveTokenEncryptionKey } from "../token-encryption.js";

const [credentialsDir, participant] = process.argv.slice(2);
if (!credentialsDir || !participant) {
	throw new Error("Expected credentials directory and participant id");
}

fs.writeFileSync(path.join(credentialsDir, `ready-${participant}`), "");
const gate = path.join(credentialsDir, "start");
while (!fs.existsSync(gate)) {
	await new Promise((resolve) => setTimeout(resolve, 1));
}

process.stdout.write(
	resolveTokenEncryptionKey(credentialsDir, {} as NodeJS.ProcessEnv).toString(
		"hex",
	),
);
