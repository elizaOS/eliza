import { execa } from "execa";

export async function runBunCommand(
	args: string[],
	cwd: string,
): Promise<void> {
	await execa("bun", args, { cwd, stdio: "inherit" });
}
