import { copyClientDist } from "../utils/copy-template.js";

async function main() {
	console.log("Running copy-client-dist script...");
	await copyClientDist();
	console.log("Script completed");
}

main().catch((error) => {
	console.error("Error running copy-client-dist script:", error);
	process.exit(1);
});
