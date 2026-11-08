/** Compiles small programs against service.ts to check its type-level contracts. */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const typesDir = path.dirname(new URL(import.meta.url).pathname);
const servicePath = path.join(typesDir, "service.ts");
const probePath = path.join(typesDir, "__service-probe.ts");

function compile(
	probe: string,
	serviceSource = readFileSync(servicePath, "utf8"),
): string[] {
	const options: ts.CompilerOptions = {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		types: [],
	};
	const host = ts.createCompilerHost(options);
	const readFile = host.readFile.bind(host);
	const getSourceFile = host.getSourceFile.bind(host);
	const overrides = new Map([
		[probePath, probe],
		[servicePath, serviceSource],
	]);
	host.fileExists = (file) => overrides.has(file) || ts.sys.fileExists(file);
	host.readFile = (file) => overrides.get(file) ?? readFile(file);
	host.getSourceFile = (file, version) => {
		const text = overrides.get(file);
		return text === undefined
			? getSourceFile(file, version)
			: ts.createSourceFile(file, text, version);
	};
	const program = ts.createProgram([probePath], options, host);
	return [probePath, servicePath].flatMap((file) =>
		program
			.getSemanticDiagnostics(program.getSourceFile(file))
			.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
	);
}

describe("service type contracts", () => {
	it("lets plugins augment ServiceClassMap and resolves ServiceInstance", () => {
		const errors = compile(`
import { Service, type ServiceInstance } from "./service";
class EmailService extends Service {
	static serviceType = "email" as const;
	capabilityDescription = "email";
	async stop() {}
	send(): string { return "sent"; }
}
declare module "./service" {
	interface ServiceClassMap {
		email: typeof EmailService;
	}
}
const instance = null as unknown as ServiceInstance<"email">;
const sent: string = instance.send();
const plain = null as unknown as ServiceInstance<"video">;
// @ts-expect-error unmapped service types resolve to the Service base class
plain.send();
export { sent };
`);
		expect(errors).toEqual([]);
	}, 60_000);

	it("accepts every ServiceType value as a ServiceTypeName", () => {
		const errors = compile(`
import { ServiceType, type IsValidServiceType } from "./service";
const notification: IsValidServiceType<typeof ServiceType.NOTIFICATION> = true;
const media: IsValidServiceType<typeof ServiceType.MEDIA_GENERATION> = true;
const voice: IsValidServiceType<typeof ServiceType.VOICE_CACHE> = true;
export { notification, media, voice };
`);
		expect(errors).toEqual([]);
	}, 60_000);

	it("fails to compile when ServiceTypeRegistry drops a ServiceType value", () => {
		const source = readFileSync(servicePath, "utf8");
		const drifted = source.replace('\tVOICE_CACHE: "voice_cache";\n', "");
		expect(drifted).not.toBe(source);
		const errors = compile(`export * from "./service";`, drifted);
		expect(errors.join("\n")).toContain('"voice_cache"');
	}, 60_000);
});
