import { readFileSync } from "node:fs";
import ts from "typescript";

const pluginFile = "packages/core/src/types/plugin.ts";
const capabilityFile = "packages/core/src/capabilities/index.ts";

const remoteSupported = new Map<string, string>([
	["name", "name"],
	["description", "description"],
	["init", "lifecycle:init"],
	["dispose", "lifecycle:dispose"],
	["applyConfig", "lifecycle:applyConfig"],
	["config", "config"],
	["services", "services"],
	["componentTypes", "componentTypes"],
	["actions", "actions"],
	["providers", "providers"],
	["evaluators", "evaluators"],
	["responseHandlerEvaluators", "responseHandlerEvaluators"],
	["responseHandlerFieldEvaluators", "responseHandlerFieldEvaluators"],
	["models", "models"],
	["events", "events"],
	["routes", "routes"],
	["priority", "priority"],
	["schema", "schema"],
	["app", "app"],
	["appBridge", "appBridge"],
	["views", "views"],
	["widgets", "widgets"],
	["contexts", "contexts"],
]);

const localOnly = new Set([
	"adapter",
	"tests",
	"dependencies",
	"testDependencies",
	"autoEnable",
]);

const remoteManifestKeys = new Set(
	readTypeMembers(capabilityFile, "RemotePluginModuleManifest"),
);
const pluginKeys = readInterfaceMembers(pluginFile, "Plugin");
const failures: string[] = [];

for (const key of pluginKeys) {
	const remoteKey = remoteSupported.get(key);
	if (remoteKey) {
		if (!remoteKey.startsWith("lifecycle:") && !remoteManifestKeys.has(remoteKey)) {
			failures.push(
				`Plugin.${key} is marked remote-supported but RemotePluginModuleManifest lacks ${remoteKey}.`,
			);
		}
		continue;
	}
	if (localOnly.has(key)) continue;
	failures.push(
		`Plugin.${key} is not classified for capability-router remote plugins.`,
	);
}

for (const key of [...remoteSupported.keys(), ...localOnly]) {
	if (!pluginKeys.includes(key)) {
		failures.push(`Surface audit references missing Plugin.${key}.`);
	}
}

if (!remoteManifestKeys.has("lifecycle")) {
	failures.push("RemotePluginModuleManifest must keep lifecycle for init/dispose/applyConfig.");
}

if (failures.length > 0) {
	console.error("[capability-router-surface-audit] failed");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log(
	JSON.stringify(
		{
			ok: true,
			pluginFields: pluginKeys.length,
			remoteSupported: remoteSupported.size,
			localOnly: localOnly.size,
		},
		null,
		2,
	),
);

function readInterfaceMembers(fileName: string, interfaceName: string): string[] {
	const source = readSourceFile(fileName);
	for (const node of source.statements) {
		if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
			return memberNames(node.members);
		}
	}
	throw new Error(`Could not find interface ${interfaceName} in ${fileName}.`);
}

function readTypeMembers(fileName: string, typeName: string): string[] {
	const source = readSourceFile(fileName);
	for (const node of source.statements) {
		if (
			ts.isTypeAliasDeclaration(node) &&
			node.name.text === typeName &&
			ts.isTypeLiteralNode(node.type)
		) {
			return memberNames(node.type.members);
		}
	}
	throw new Error(`Could not find type literal ${typeName} in ${fileName}.`);
}

function memberNames(members: ts.NodeArray<ts.TypeElement>): string[] {
	return members.flatMap((member) => {
		if (
			(ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
			member.name
		) {
			if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) {
				return [member.name.text];
			}
		}
		return [];
	});
}

function readSourceFile(fileName: string): ts.SourceFile {
	return ts.createSourceFile(
		fileName,
		readFileSync(fileName, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}
