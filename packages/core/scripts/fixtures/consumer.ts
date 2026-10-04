import {
	AgentRuntime,
	type Entity,
	type IAgentRuntime,
	type MemoryConfig,
	type MessageExample,
	ModelType,
	type Plugin,
	type UUID,
} from "@elizaos/core";

// @ts-expect-error Runtime entities retain their separate account shape.
export type InvalidRuntimeGraphName = Entity["preferredName"];
// @ts-expect-error Runtime message examples use name, not the first-run user field.
export type InvalidRuntimeExampleUser = MessageExample["user"];
// @ts-expect-error Runtime memory settings retain their separate shape.
export type InvalidRuntimeMemoryBackend = MemoryConfig["backend"];

import type { CatalogModel, RuntimeClass } from "@elizaos/contracts";

const runtimeClass: RuntimeClass = "fused-eliza1";
const catalogRuntimeClass: CatalogModel["runtimeClass"] = runtimeClass;
// @ts-expect-error The wire discriminator must remain typed without a native plugin installation.
const invalidRuntimeClass: CatalogModel["runtimeClass"] = "missing-runtime";
void catalogRuntimeClass;
void invalidRuntimeClass;

import type {
	AgentLogEntry,
	AgentStreamEventType,
	LogEntry,
	StreamEventType,
} from "@elizaos/core";

const hostEvent: AgentStreamEventType = "agent_event";
// @ts-expect-error Runtime stream events retain their own discriminator.
const runtimeEvent: StreamEventType = hostEvent;
void runtimeEvent;
const hostLog: AgentLogEntry["source"] = "host";
void hostLog;
void (null as unknown as LogEntry);

import type * as PublicCore from "@elizaos/core";
// @ts-expect-error Host composition facade types are retired in v2.
export type RetiredMerge = PublicCore.AgentRecordForMerge;
// @ts-expect-error Host composition facade types are retired in v2.
export type RetiredRuntimes = PublicCore.CreateRuntimesOptions;
// @ts-expect-error Host composition facade types are retired in v2.
export type RetiredCharacters = PublicCore.LoadCharactersOptions;

const plugin: Plugin = {
	name: "consumer",
	description: "typed consumer",
	models: { [ModelType.TEXT_SMALL]: async (_runtime, _params) => "fixture" },
};
const runtime: IAgentRuntime = new AgentRuntime({
	character: { name: "consumer", bio: [] },
	plugins: [plugin],
});
const id: UUID = runtime.agentId;
void id;
const text: Promise<string> = runtime.useModel(ModelType.TEXT_SMALL, {
	prompt: "fixture",
});
void text;

import {
	EchoReferenceBuffer,
	type EchoReferenceBufferOptions,
} from "@elizaos/voice";

const voiceOptions: EchoReferenceBufferOptions = { capacitySamples: 32 };
const voiceReference = new EchoReferenceBuffer(voiceOptions);
voiceReference.push(new Float32Array([0, 1]));
