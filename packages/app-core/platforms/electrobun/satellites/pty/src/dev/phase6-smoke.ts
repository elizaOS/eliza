import { PtyException } from "../bun/errors.ts";
import { TerminalSatelliteService } from "../bun/pty-service.ts";

const service = new TerminalSatelliteService();
const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
const printArgs =
	process.platform === "win32"
		? ["/c", "echo pty smoke"]
		: ["-c", "printf 'pty smoke\\n'"];
const sleepArgs =
	process.platform === "win32"
		? ["/c", "ping -n 10 127.0.0.1 > nul"]
		: ["-c", "sleep 10"];

const result = await service.createSession({
	command: shell,
	args: printArgs,
});
const smokeOutput = await waitForOutput(result.session.id, "pty smoke", 3000);
assert(smokeOutput.includes("pty smoke"), "output contains pty smoke");

const listed = await service.listSessions();
assert(
	listed.some((session) => session.id === result.session.id),
	"listSessions includes smoke session",
);

const fetched = await service.getSession(result.session.id);
assert(fetched.id === result.session.id, "getSession returns smoke session");

const interactive = await service.createSession({ command: shell });
await service.resize({
	sessionId: interactive.session.id,
	cols: 100,
	rows: 24,
});
await service.write({
	sessionId: interactive.session.id,
	data:
		process.platform === "win32"
			? "echo write smoke\r\nexit\r\n"
			: "printf 'write smoke\\n'\nexit\n",
});
const writeOutput = await waitForOutput(
	interactive.session.id,
	"write smoke",
	3000,
);
assert(writeOutput.includes("write smoke"), "write sends stdin to session");

const killSession = await service.createSession({
	command: shell,
	args: sleepArgs,
});
const killed = await service.kill({ sessionId: killSession.session.id });
assert(killed.status === "killed", "kill marks session killed");

await expectPtyError(
	() => service.getSession("missing-session"),
	"PTY_SESSION_NOT_FOUND",
	"missing session reports structured error",
);

const commandRun = await service.commandRun({
	command: shell,
	args: printArgs,
	timeoutMs: 3000,
});
assert(commandRun.output.includes("pty smoke"), "command.run captures output");

process.stdout.write(
	`${JSON.stringify(
		{
			ok: true,
			implementation: "bun-terminal",
			truePty: true,
			sessions: (await service.listSessions()).map((session) => ({
				id: session.id,
				status: session.status,
				exitCode: session.exitCode,
			})),
		},
		null,
		2,
	)}\n`,
);

async function waitForOutput(
	sessionId: string,
	expected: string,
	timeoutMs: number,
): Promise<string> {
	const startedAt = Date.now();
	let afterSequence = -1;
	let output = "";
	while (Date.now() - startedAt < timeoutMs) {
		const tail = await service.outputTail({
			sessionId,
			afterSequence,
			limit: 200,
		});
		afterSequence = tail.nextSequence - 1;
		output += tail.entries.map((entry) => entry.data).join("");
		if (output.includes(expected)) return output;
		await Bun.sleep(50);
	}
	return output;
}

async function expectPtyError(
	action: () => Promise<unknown>,
	code: string,
	message: string,
): Promise<void> {
	try {
		await action();
	} catch (error) {
		if (error instanceof PtyException && error.code === code) return;
		throw error;
	}
	throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
