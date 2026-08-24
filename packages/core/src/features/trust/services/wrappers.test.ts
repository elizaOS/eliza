/**
 * Deterministic unit tests for the trust capability's service wrappers: startup
 * construction and initialization ordering, dependency lookup through
 * `getServiceLoadPromise`, and exact argument/result forwarding of every proxy
 * method onto the wrapped engines. The four engine modules are replaced with
 * `vi.mock` factories so the harness needs no runtime, database, or network;
 * the wrapper code under test is exercised directly and every assertion checks
 * argument identity, result identity, or error propagation.
 */

import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type IAgentRuntime,
	Service,
	type UUID,
} from "../../../types/index.ts";
import type {
	AccessRequest,
	Permission,
	PermissionContext,
} from "../types/permissions.ts";
import {
	type SecurityAction,
	type SecurityContext,
	SecurityEventType,
	type SecurityMessage,
} from "../types/security.ts";
import type { TrustRequirements } from "../types/trust.ts";

vi.mock("./TrustEngine.ts", () => ({ TrustEngine: vi.fn() }));
vi.mock("./SecurityModule.ts", () => ({ SecurityModule: vi.fn() }));
vi.mock("./CredentialProtector.ts", () => ({ CredentialProtector: vi.fn() }));
vi.mock("./ContextualPermissionSystem.ts", () => ({
	ContextualPermissionSystem: vi.fn(),
}));

import { ContextualPermissionSystem } from "./ContextualPermissionSystem.ts";
import type { CredentialThreatDetection } from "./CredentialProtector.ts";
import { CredentialProtector } from "./CredentialProtector.ts";
import { SecurityModule } from "./SecurityModule.ts";
import { TrustEngine } from "./TrustEngine.ts";
import {
	ContextualPermissionSystemServiceWrapper,
	CredentialProtectorServiceWrapper,
	SecurityModuleServiceWrapper,
	TrustEngineServiceWrapper,
} from "./wrappers.ts";

const TrustEngineMock = vi.mocked(TrustEngine);
const SecurityModuleMock = vi.mocked(SecurityModule);
const CredentialProtectorMock = vi.mocked(CredentialProtector);
const ContextualPermissionSystemMock = vi.mocked(ContextualPermissionSystem);

const ENTITY_A = "00000000-0000-0000-0000-0000000000a1" as UUID;
const ENTITY_B = "00000000-0000-0000-0000-0000000000b2" as UUID;
const ROOM_A = "00000000-0000-0000-0000-00000000d001" as UUID;

type AnyMock = Mock<(...args: unknown[]) => unknown>;

/**
 * Seeds the next instance produced by a mocked engine constructor with the
 * given members (method mocks). Uses a constructable function body because the
 * wrappers invoke their engines with `new`; arrow implementations cannot be
 * constructed under vitest's spy layer.
 */
function seedConstructor(
	mock: {
		mockImplementation: (impl: (...args: unknown[]) => unknown) => unknown;
	},
	members: Record<string, unknown>,
): void {
	mock.mockImplementation(function (this: Record<string, unknown>) {
		Object.assign(this, members);
	});
}

function constructed<T>(mock: { mock: { instances: unknown[] } }): T {
	expect(mock.mock.instances.length).toBeGreaterThan(0);
	return mock.mock.instances[mock.mock.instances.length - 1] as T;
}

function makeRuntime(
	deps: Record<string, unknown> = {},
): IAgentRuntime & { getServiceLoadPromise: AnyMock } {
	return {
		getServiceLoadPromise: vi.fn((serviceType: string) => {
			if (!(serviceType in deps)) {
				throw new Error(`unexpected dependency request: ${serviceType}`);
			}
			return Promise.resolve(deps[serviceType]);
		}),
	} as unknown as IAgentRuntime & { getServiceLoadPromise: AnyMock };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("wrapper registration metadata", () => {
	it("declares the service types the trust plugin registers under", () => {
		expect(TrustEngineServiceWrapper.serviceType).toBe("trust-engine");
		expect(SecurityModuleServiceWrapper.serviceType).toBe("security-module");
		expect(CredentialProtectorServiceWrapper.serviceType).toBe(
			"credential-protector",
		);
		expect(ContextualPermissionSystemServiceWrapper.serviceType).toBe(
			"contextual-permissions",
		);
	});

	it("declares a capability description per wrapper", () => {
		expect(new TrustEngineServiceWrapper().capabilityDescription).toBe(
			"Multi-dimensional trust scoring and evidence-based trust evaluation",
		);
		expect(new SecurityModuleServiceWrapper().capabilityDescription).toBe(
			"Security threat detection and trust-based security analysis",
		);
		expect(new CredentialProtectorServiceWrapper().capabilityDescription).toBe(
			"Detects and prevents credential theft attempts, protects sensitive data",
		);
		expect(
			new ContextualPermissionSystemServiceWrapper().capabilityDescription,
		).toBe(
			"Context-aware permission management with trust-based access control",
		);
	});

	it("produces Service instances", () => {
		expect(new TrustEngineServiceWrapper()).toBeInstanceOf(Service);
		expect(new SecurityModuleServiceWrapper()).toBeInstanceOf(Service);
		expect(new CredentialProtectorServiceWrapper()).toBeInstanceOf(Service);
		expect(new ContextualPermissionSystemServiceWrapper()).toBeInstanceOf(
			Service,
		);
	});

	it("stops without touching any wrapped engine", async () => {
		await expect(
			new TrustEngineServiceWrapper().stop(),
		).resolves.toBeUndefined();
		await expect(
			new SecurityModuleServiceWrapper().stop(),
		).resolves.toBeUndefined();
		await expect(
			new CredentialProtectorServiceWrapper().stop(),
		).resolves.toBeUndefined();
		await expect(
			new ContextualPermissionSystemServiceWrapper().stop(),
		).resolves.toBeUndefined();
	});
});

describe("TrustEngineServiceWrapper.start", () => {
	it("constructs one engine, initializes it with the runtime, and returns only after initialization completes", async () => {
		const initialize = vi.fn();
		const initGate = deferred<void>();
		initialize.mockResolvedValue(undefined);
		initialize.mockReturnValue(initGate.promise);
		seedConstructor(TrustEngineMock, { initialize });
		const runtime = makeRuntime();

		const pending = TrustEngineServiceWrapper.start(runtime);

		expect(initialize).toHaveBeenCalledTimes(1);
		expect(initialize).toHaveBeenCalledWith(runtime);

		initGate.resolve();
		const started = (await pending) as TrustEngineServiceWrapper;

		expect(started).toBeInstanceOf(TrustEngineServiceWrapper);
		expect(TrustEngineMock).toHaveBeenCalledTimes(1);
		expect(started.trustEngine).toBe(constructed<unknown>(TrustEngineMock));
		expect(
			constructed<{ initialize: unknown }>(TrustEngineMock).initialize,
		).toBe(initialize);
	});

	it("propagates an engine initialization failure", async () => {
		seedConstructor(TrustEngineMock, {
			initialize: vi.fn().mockRejectedValue(new Error("engine init failed")),
		});

		await expect(
			TrustEngineServiceWrapper.start(makeRuntime()),
		).rejects.toThrow("engine init failed");
	});
});

describe("SecurityModuleServiceWrapper.start", () => {
	it("waits for the trust-engine service and initializes the module with its engine", async () => {
		const engine = { id: "wrapped-trust-engine" };
		const initialize = vi.fn().mockResolvedValue(undefined);
		seedConstructor(SecurityModuleMock, { initialize });
		const runtime = makeRuntime({
			"trust-engine": { trustEngine: engine },
		});

		const started = (await SecurityModuleServiceWrapper.start(
			runtime,
		)) as SecurityModuleServiceWrapper;

		expect(runtime.getServiceLoadPromise).toHaveBeenCalledTimes(1);
		expect(runtime.getServiceLoadPromise).toHaveBeenCalledWith("trust-engine");
		expect(initialize).toHaveBeenCalledTimes(1);
		expect(initialize).toHaveBeenCalledWith(runtime, engine);
		expect(started.securityModule).toBe(
			constructed<unknown>(SecurityModuleMock),
		);
	});

	it("propagates a dependency lookup failure without constructing the module", async () => {
		const runtime = makeRuntime();
		runtime.getServiceLoadPromise.mockRejectedValue(
			new Error("trust-engine unavailable"),
		);

		await expect(SecurityModuleServiceWrapper.start(runtime)).rejects.toThrow(
			"trust-engine unavailable",
		);
		expect(SecurityModuleMock).not.toHaveBeenCalled();
	});

	it("propagates a module initialization failure", async () => {
		seedConstructor(SecurityModuleMock, {
			initialize: vi.fn().mockRejectedValue(new Error("module init failed")),
		});

		await expect(
			SecurityModuleServiceWrapper.start(
				makeRuntime({ "trust-engine": { trustEngine: {} } }),
			),
		).rejects.toThrow("module init failed");
	});
});

describe("CredentialProtectorServiceWrapper.start", () => {
	it("waits for the security-module service and initializes the protector with its module", async () => {
		const securityModule = { id: "wrapped-security-module" };
		const initialize = vi.fn().mockResolvedValue(undefined);
		seedConstructor(CredentialProtectorMock, { initialize });
		const runtime = makeRuntime({
			"security-module": { securityModule },
		});

		const started = (await CredentialProtectorServiceWrapper.start(
			runtime,
		)) as CredentialProtectorServiceWrapper;

		expect(runtime.getServiceLoadPromise).toHaveBeenCalledTimes(1);
		expect(runtime.getServiceLoadPromise).toHaveBeenCalledWith(
			"security-module",
		);
		expect(initialize).toHaveBeenCalledTimes(1);
		expect(initialize).toHaveBeenCalledWith(runtime, securityModule);
		expect(started.credentialProtector).toBe(
			constructed<unknown>(CredentialProtectorMock),
		);
	});

	it("propagates a dependency lookup failure without constructing the protector", async () => {
		const runtime = makeRuntime();
		runtime.getServiceLoadPromise.mockRejectedValue(
			new Error("security-module unavailable"),
		);

		await expect(
			CredentialProtectorServiceWrapper.start(runtime),
		).rejects.toThrow("security-module unavailable");
		expect(CredentialProtectorMock).not.toHaveBeenCalled();
	});
});

describe("ContextualPermissionSystemServiceWrapper.start", () => {
	it("requests both dependencies before either resolves, then initializes with both engines", async () => {
		const trustEngine = { id: "wrapped-trust-engine" };
		const securityModule = { id: "wrapped-security-module" };
		const trustEngineGate = deferred<{ trustEngine: unknown }>();
		const securityModuleGate = deferred<{ securityModule: unknown }>();
		const getServiceLoadPromise = vi.fn((serviceType: string) =>
			serviceType === "trust-engine"
				? trustEngineGate.promise
				: securityModuleGate.promise,
		);
		const runtime = { getServiceLoadPromise } as unknown as IAgentRuntime;

		const initialize = vi.fn().mockResolvedValue(undefined);
		seedConstructor(ContextualPermissionSystemMock, { initialize });

		const pending = ContextualPermissionSystemServiceWrapper.start(runtime);

		expect(getServiceLoadPromise).toHaveBeenCalledTimes(2);
		expect(getServiceLoadPromise).toHaveBeenCalledWith("trust-engine");
		expect(getServiceLoadPromise).toHaveBeenCalledWith("security-module");
		expect(initialize).not.toHaveBeenCalled();

		trustEngineGate.resolve({ trustEngine });
		securityModuleGate.resolve({ securityModule });
		const started = (await pending) as ContextualPermissionSystemServiceWrapper;

		expect(initialize).toHaveBeenCalledTimes(1);
		expect(initialize).toHaveBeenCalledWith(
			runtime,
			trustEngine,
			securityModule,
		);
		expect(started.permissionSystem).toBe(
			constructed<unknown>(ContextualPermissionSystemMock),
		);
	});

	it("rejects when the first dependency rejects even if the second is still pending", async () => {
		const failingGate = deferred<never>();
		failingGate.reject(new Error("trust-engine boom"));
		const pendingGate = deferred<{ securityModule: unknown }>();
		const runtime = {
			getServiceLoadPromise: vi.fn((serviceType: string) =>
				serviceType === "trust-engine"
					? failingGate.promise
					: pendingGate.promise,
			),
		} as unknown as IAgentRuntime;

		await expect(
			ContextualPermissionSystemServiceWrapper.start(runtime),
		).rejects.toThrow("trust-engine boom");
		expect(ContextualPermissionSystemMock).not.toHaveBeenCalled();
	});

	it("propagates a permission system initialization failure", async () => {
		seedConstructor(ContextualPermissionSystemMock, {
			initialize: vi
				.fn()
				.mockRejectedValue(new Error("permissions init failed")),
		});

		await expect(
			ContextualPermissionSystemServiceWrapper.start(
				makeRuntime({
					"trust-engine": { trustEngine: {} },
					"security-module": { securityModule: {} },
				}),
			),
		).rejects.toThrow("permissions init failed");
	});
});

describe("TrustEngineServiceWrapper proxies", () => {
	function wrapperWith(engine: Record<string, unknown>) {
		const wrapper = new TrustEngineServiceWrapper();
		wrapper.trustEngine = engine as unknown as TrustEngine;
		return wrapper;
	}

	it("forwards calculateTrust unchanged and resolves with the engine's profile", async () => {
		const profile = { overallScore: 0.75 };
		const calculateTrust = vi.fn().mockResolvedValue(profile);
		const wrapper = wrapperWith({ calculateTrust });

		await expect(
			wrapper.calculateTrust(ENTITY_A, { evaluatorId: ENTITY_B }),
		).resolves.toBe(profile);
		expect(calculateTrust).toHaveBeenCalledTimes(1);
		expect(calculateTrust).toHaveBeenCalledWith(ENTITY_A, {
			evaluatorId: ENTITY_B,
		});
	});

	it("propagates a calculateTrust rejection from the engine", async () => {
		const wrapper = wrapperWith({
			calculateTrust: vi.fn().mockRejectedValue(new Error("scoring failed")),
		});

		await expect(
			wrapper.calculateTrust(ENTITY_A, { evaluatorId: ENTITY_B }),
		).rejects.toThrow("scoring failed");
	});

	it("forwards getRecentInteractions with an omitted limit as undefined", async () => {
		const interactions = [{ entityId: ENTITY_B }];
		const getRecentInteractions = vi.fn().mockResolvedValue(interactions);
		const wrapper = wrapperWith({ getRecentInteractions });

		await expect(wrapper.getRecentInteractions(ENTITY_A)).resolves.toBe(
			interactions,
		);
		expect(getRecentInteractions).toHaveBeenCalledWith(ENTITY_A, undefined);
	});

	it("forwards boundary limits of zero and positive values unchanged", async () => {
		const getRecentInteractions = vi.fn().mockResolvedValue([]);
		const wrapper = wrapperWith({ getRecentInteractions });

		await wrapper.getRecentInteractions(ENTITY_A, 0);
		expect(getRecentInteractions).toHaveBeenLastCalledWith(ENTITY_A, 0);

		await wrapper.getRecentInteractions(ENTITY_A, 5);
		expect(getRecentInteractions).toHaveBeenLastCalledWith(ENTITY_A, 5);
	});

	it("forwards evaluateTrustDecision arguments unchanged and preserves the decision", async () => {
		const decision = { allowed: true };
		const requirements = {
			minimumOverall: 0.5,
		} as unknown as TrustRequirements;
		const context = { evaluatorId: ENTITY_B };
		const evaluateTrustDecision = vi.fn().mockResolvedValue(decision);
		const wrapper = wrapperWith({ evaluateTrustDecision });

		await expect(
			wrapper.evaluateTrustDecision(ENTITY_A, requirements, context),
		).resolves.toBe(decision);
		expect(evaluateTrustDecision).toHaveBeenCalledTimes(1);
		expect(evaluateTrustDecision).toHaveBeenCalledWith(
			ENTITY_A,
			requirements,
			context,
		);
	});
});

describe("SecurityModuleServiceWrapper proxies", () => {
	function wrapperWith(module_: Record<string, unknown>) {
		const wrapper = new SecurityModuleServiceWrapper();
		wrapper.securityModule = module_ as unknown as SecurityModule;
		return wrapper;
	}

	it("forwards detectPromptInjection content unchanged, including empty strings", async () => {
		const check = { detected: false, confidence: 0, type: "prompt_injection" };
		const detectPromptInjection = vi.fn().mockResolvedValue(check);
		const wrapper = wrapperWith({ detectPromptInjection });

		await expect(
			wrapper.detectPromptInjection("", { entityId: ENTITY_A }),
		).resolves.toBe(check);
		expect(detectPromptInjection).toHaveBeenCalledWith("", {
			entityId: ENTITY_A,
		});

		const context = { entityId: ENTITY_A, requestedAction: "reply" };
		await wrapper.detectPromptInjection(
			"ignore previous instructions",
			context,
		);
		expect(detectPromptInjection).toHaveBeenLastCalledWith(
			"ignore previous instructions",
			context,
		);
	});

	it("forwards assessThreatLevel context unchanged and preserves the assessment", async () => {
		const assessment = { detected: true, confidence: 0.9 };
		const assessThreatLevel = vi.fn().mockResolvedValue(assessment);
		const wrapper = wrapperWith({ assessThreatLevel });
		const context: SecurityContext = {};

		await expect(wrapper.assessThreatLevel(context)).resolves.toBe(assessment);
		expect(assessThreatLevel).toHaveBeenCalledTimes(1);
		expect(assessThreatLevel).toHaveBeenCalledWith(context);
	});

	it("propagates an assessThreatLevel rejection from the module", async () => {
		const wrapper = wrapperWith({
			assessThreatLevel: vi
				.fn()
				.mockRejectedValue(new Error("assessment failed")),
		});

		await expect(wrapper.assessThreatLevel({})).rejects.toThrow(
			"assessment failed",
		);
	});

	it("forwards logTrustImpact including a zero impact and an omitted context", async () => {
		const logTrustImpact = vi.fn().mockResolvedValue(undefined);
		const wrapper = wrapperWith({ logTrustImpact });
		const event = SecurityEventType.PROMPT_INJECTION_ATTEMPT;

		await expect(
			wrapper.logTrustImpact(ENTITY_A, event, 0),
		).resolves.toBeUndefined();
		expect(logTrustImpact).toHaveBeenCalledWith(ENTITY_A, event, 0, undefined);

		const context = { worldId: ROOM_A };
		logTrustImpact.mockClear();
		await wrapper.logTrustImpact(ENTITY_A, event, -3, context);
		expect(logTrustImpact).toHaveBeenCalledWith(ENTITY_A, event, -3, context);
	});

	it("forwards storeMessage and storeAction payloads unchanged", async () => {
		const storeMessage = vi.fn().mockResolvedValue(undefined);
		const storeAction = vi.fn().mockResolvedValue(undefined);
		const wrapper = wrapperWith({ storeMessage, storeAction });
		const message = { content: "hello" } as unknown as SecurityMessage;
		const action = { name: "REPLY" } as unknown as SecurityAction;

		await expect(wrapper.storeMessage(message)).resolves.toBeUndefined();
		expect(storeMessage).toHaveBeenCalledTimes(1);
		expect(storeMessage).toHaveBeenCalledWith(message);

		await expect(wrapper.storeAction(action)).resolves.toBeUndefined();
		expect(storeAction).toHaveBeenCalledTimes(1);
		expect(storeAction).toHaveBeenCalledWith(action);
	});

	it("forwards detectMultiAccountPattern entities and time windows, preserving null results", async () => {
		const detection = { pattern: "burst" };
		const detectMultiAccountPattern = vi
			.fn()
			.mockResolvedValueOnce(detection)
			.mockResolvedValueOnce(null);
		const wrapper = wrapperWith({ detectMultiAccountPattern });

		await expect(
			wrapper.detectMultiAccountPattern([ENTITY_A, ENTITY_B], 60),
		).resolves.toBe(detection);
		expect(detectMultiAccountPattern).toHaveBeenCalledWith(
			[ENTITY_A, ENTITY_B],
			60,
		);

		await expect(wrapper.detectMultiAccountPattern([])).resolves.toBeNull();
		expect(detectMultiAccountPattern).toHaveBeenLastCalledWith([], undefined);

		await wrapper.detectMultiAccountPattern([ENTITY_A], 0);
		expect(detectMultiAccountPattern).toHaveBeenLastCalledWith([ENTITY_A], 0);
	});

	it("forwards detectImpersonation inputs, preserving null for empty inputs", async () => {
		const detection = { impersonated: "admin" };
		const detectImpersonation = vi
			.fn()
			.mockResolvedValueOnce(detection)
			.mockResolvedValueOnce(null);
		const wrapper = wrapperWith({ detectImpersonation });

		await expect(wrapper.detectImpersonation("adm1n", ["admin"])).resolves.toBe(
			detection,
		);
		expect(detectImpersonation).toHaveBeenCalledWith("adm1n", ["admin"]);

		await expect(wrapper.detectImpersonation("", [])).resolves.toBeNull();
		expect(detectImpersonation).toHaveBeenLastCalledWith("", []);
	});

	it("forwards detectPhishing messages and entity, preserving null for an empty inbox", async () => {
		const detection = { phishing: true };
		const detectPhishing = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(detection);
		const wrapper = wrapperWith({ detectPhishing });

		await expect(wrapper.detectPhishing([], ENTITY_A)).resolves.toBeNull();
		expect(detectPhishing).toHaveBeenLastCalledWith([], ENTITY_A);

		const messages = [{ content: "click here" } as unknown as SecurityMessage];
		await expect(wrapper.detectPhishing(messages, ENTITY_B)).resolves.toBe(
			detection,
		);
		expect(detectPhishing).toHaveBeenLastCalledWith(messages, ENTITY_B);
	});

	it("forwards getRecentSecurityIncidents filters, including omitted and zero-valued bounds", async () => {
		const events = [{ severity: "high" }];
		const getRecentSecurityIncidents = vi.fn().mockResolvedValue(events);
		const wrapper = wrapperWith({ getRecentSecurityIncidents });

		await expect(wrapper.getRecentSecurityIncidents()).resolves.toBe(events);
		expect(getRecentSecurityIncidents).toHaveBeenCalledWith(
			undefined,
			undefined,
		);

		await expect(wrapper.getRecentSecurityIncidents(ROOM_A, 0)).resolves.toBe(
			events,
		);
		expect(getRecentSecurityIncidents).toHaveBeenLastCalledWith(ROOM_A, 0);

		getRecentSecurityIncidents.mockResolvedValue([]);
		await expect(
			wrapper.getRecentSecurityIncidents(ROOM_A, 24),
		).resolves.toEqual([]);
		expect(getRecentSecurityIncidents).toHaveBeenLastCalledWith(ROOM_A, 24);
	});

	it("forwards analyzeMessage inputs unchanged, including empty messages", async () => {
		const check = { detected: false, confidence: 0 };
		const analyzeMessage = vi.fn().mockResolvedValue(check);
		const wrapper = wrapperWith({ analyzeMessage });
		const context: SecurityContext = { entityId: ENTITY_A };

		await expect(wrapper.analyzeMessage("", ENTITY_B, context)).resolves.toBe(
			check,
		);
		expect(analyzeMessage).toHaveBeenCalledTimes(1);
		expect(analyzeMessage).toHaveBeenCalledWith("", ENTITY_B, context);
	});

	it("delegates getSecurityRecommendations synchronously and returns the module's array identity", () => {
		const recommendations = ["enable rate limiting"];
		const getSecurityRecommendations = vi.fn().mockReturnValue(recommendations);
		const wrapper = wrapperWith({ getSecurityRecommendations });

		expect(wrapper.getSecurityRecommendations(0)).toBe(recommendations);
		expect(wrapper.getSecurityRecommendations(3)).toBe(recommendations);
		expect(getSecurityRecommendations).toHaveBeenCalledTimes(2);
		expect(getSecurityRecommendations).toHaveBeenNthCalledWith(1, 0);
		expect(getSecurityRecommendations).toHaveBeenNthCalledWith(2, 3);
	});
});

describe("CredentialProtectorServiceWrapper proxies", () => {
	function wrapperWith(protector: Record<string, unknown>) {
		const wrapper = new CredentialProtectorServiceWrapper();
		wrapper.credentialProtector = protector as unknown as CredentialProtector;
		return wrapper;
	}

	it("forwards scanForCredentialTheft inputs unchanged, including empty messages", async () => {
		const findings = { threats: [] };
		const scanForCredentialTheft = vi.fn().mockResolvedValue(findings);
		const wrapper = wrapperWith({ scanForCredentialTheft });
		const context: SecurityContext = {};

		await expect(
			wrapper.scanForCredentialTheft("", ENTITY_A, context),
		).resolves.toBe(findings);
		expect(scanForCredentialTheft).toHaveBeenCalledTimes(1);
		expect(scanForCredentialTheft).toHaveBeenCalledWith("", ENTITY_A, context);
	});

	it("preserves protectSensitiveData resolutions and rejections", async () => {
		const protectSensitiveData = vi
			.fn()
			.mockResolvedValueOnce("[REDACTED]")
			.mockRejectedValueOnce(new Error("protection failed"));
		const wrapper = wrapperWith({ protectSensitiveData });

		await expect(wrapper.protectSensitiveData("")).resolves.toBe("[REDACTED]");
		expect(protectSensitiveData).toHaveBeenLastCalledWith("");

		await expect(wrapper.protectSensitiveData("api_key=abc")).rejects.toThrow(
			"protection failed",
		);
		expect(protectSensitiveData).toHaveBeenLastCalledWith("api_key=abc");
	});

	it("forwards alertPotentialVictims recipients unchanged and resolves void", async () => {
		const alertPotentialVictims = vi.fn().mockResolvedValue(undefined);
		const wrapper = wrapperWith({ alertPotentialVictims });
		const details = {
			type: "credential_theft",
		} as unknown as CredentialThreatDetection;

		await expect(
			wrapper.alertPotentialVictims(ENTITY_A, [ENTITY_B], details),
		).resolves.toBeUndefined();
		expect(alertPotentialVictims).toHaveBeenCalledTimes(1);
		expect(alertPotentialVictims).toHaveBeenCalledWith(
			ENTITY_A,
			[ENTITY_B],
			details,
		);

		alertPotentialVictims.mockClear();
		await wrapper.alertPotentialVictims(ENTITY_A, [], details);
		expect(alertPotentialVictims).toHaveBeenCalledWith(ENTITY_A, [], details);
	});
});

describe("ContextualPermissionSystemServiceWrapper proxies", () => {
	function wrapperWith(system: Record<string, unknown>) {
		const wrapper = new ContextualPermissionSystemServiceWrapper();
		wrapper.permissionSystem = system as unknown as ContextualPermissionSystem;
		return wrapper;
	}

	it("forwards checkAccess requests unchanged and preserves the decision", async () => {
		const decision = { granted: true };
		const checkAccess = vi.fn().mockResolvedValue(decision);
		const wrapper = wrapperWith({ checkAccess });
		const request: AccessRequest = {
			entityId: ENTITY_A,
			action: "send_message",
			resource: "room:1",
			context: {},
		};

		await expect(wrapper.checkAccess(request)).resolves.toBe(decision);
		expect(checkAccess).toHaveBeenCalledTimes(1);
		expect(checkAccess).toHaveBeenCalledWith(request);
	});

	it("propagates a checkAccess rejection from the system", async () => {
		const wrapper = wrapperWith({
			checkAccess: vi.fn().mockRejectedValue(new Error("access check failed")),
		});
		const request: AccessRequest = {
			entityId: ENTITY_A,
			action: "send_message",
			resource: "room:1",
			context: {},
		};

		await expect(wrapper.checkAccess(request)).rejects.toThrow(
			"access check failed",
		);
	});

	it("forwards hasPermission inputs and preserves true and false verdicts", async () => {
		const hasPermission = vi
			.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const wrapper = wrapperWith({ hasPermission });
		const permission: Permission = { action: "manage_roles", resource: "*" };
		const context: PermissionContext = {};

		await expect(
			wrapper.hasPermission(ENTITY_A, permission, context),
		).resolves.toBe(true);
		expect(hasPermission).toHaveBeenCalledWith(ENTITY_A, permission, context);

		await expect(
			wrapper.hasPermission(ENTITY_B, permission, context),
		).resolves.toBe(false);
		expect(hasPermission).toHaveBeenLastCalledWith(
			ENTITY_B,
			permission,
			context,
		);
	});
});
