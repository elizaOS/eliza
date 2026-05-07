import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import formPlugin, { FormService } from "./index";
import { formRestoreAction } from "./actions/restore";
import { formEvaluator } from "./evaluators/extractor";
import { formContextProvider } from "./providers/context";
import type { FormDefinition, FormSession } from "./types";

const entityId = "00000000-0000-4000-8000-000000000001" as UUID;
const roomId = "00000000-0000-4000-8000-000000000002" as UUID;
const agentId = "00000000-0000-4000-8000-000000000003" as UUID;

function makeMessage(text: string): Memory {
  return {
    id: "00000000-0000-4000-8000-000000000004" as UUID,
    entityId,
    roomId,
    content: { text },
  } as Memory;
}

function makeSession(overrides: Partial<FormSession> = {}): FormSession {
  const now = Date.now();
  return {
    id: "session-1",
    formId: "signup",
    formVersion: 1,
    entityId,
    roomId,
    status: "active",
    fields: {
      name: {
        status: "filled",
        value: "Jane",
        source: "manual",
        updatedAt: now,
      },
      email: { status: "empty" },
      phone: { status: "empty" },
    },
    history: [],
    effort: {
      interactionCount: 1,
      timeSpentMs: 1000,
      firstInteractionAt: now,
      lastInteractionAt: now,
    },
    expiresAt: now + 86_400_000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const signupForm: FormDefinition = {
  id: "signup",
  name: "Signup",
  description: "Collect signup details",
  controls: [
    {
      key: "name",
      label: "Name",
      type: "text",
      required: true,
    },
    {
      key: "email",
      label: "Email",
      type: "email",
      required: true,
      askPrompt: "What email should I use?",
    },
    {
      key: "phone",
      label: "Phone",
      type: "text",
      required: false,
    },
  ],
};

function makeRuntime(formService: unknown, modelResponse?: string) {
  const useModel = vi.fn(async () => modelResponse ?? "");
  return {
    agentId,
    getService: vi.fn((serviceType: string) =>
      serviceType === "FORM" ? formService : null,
    ),
    getRoom: vi.fn(async () => ({ id: roomId, worldId: agentId })),
    useModel,
    emitEvent: vi.fn(async () => undefined),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
  } as unknown as IAgentRuntime & { useModel: typeof useModel };
}

describe("plugin-form registration", () => {
  it("registers the FORM service, context provider, evaluator, and restore action", async () => {
    expect(formPlugin.name).toBe("form");
    expect(formPlugin.services?.map((service) => service.serviceType)).toEqual([
      "FORM",
    ]);
    expect(formPlugin.providers?.map((provider) => provider.name)).toContain(
      "FORM_CONTEXT",
    );
    expect(formPlugin.evaluators?.map((evaluator) => evaluator.name)).toContain(
      "form_evaluator",
    );
    expect(formPlugin.actions?.map((action) => action.name)).toContain(
      "FORM_RESTORE",
    );

    const runtime = makeRuntime(null);
    const service = (await FormService.start(runtime)) as FormService;
    expect(service.listControlTypes().map((type) => type.id)).toContain(
      "email",
    );
    await service.stop();
  });
});

describe("FORM_CONTEXT provider", () => {
  it("emits JSON form context for active and stashed forms", async () => {
    const active = makeSession();
    const stashed = makeSession({
      id: "session-stashed",
      status: "stashed",
      updatedAt: active.updatedAt - 1000,
    });
    const formService = {
      getActiveSession: vi.fn(async () => active),
      getStashedSessions: vi.fn(async () => [stashed]),
      getForm: vi.fn(() => signupForm),
      getSessionContext: vi.fn((session: FormSession) => ({
        hasActiveForm: session.status !== "stashed",
        formId: session.formId,
        formName: signupForm.name,
        progress: session.status === "stashed" ? 33 : 50,
        filledFields: [
          {
            key: "name",
            label: "Name",
            displayValue: "Jane",
          },
        ],
        missingRequired: [
          {
            key: "email",
            label: "Email",
            askPrompt: "What email should I use?",
          },
        ],
        uncertainFields: [],
        nextField: signupForm.controls[1],
        status: session.status,
        stashedCount: 1,
        pendingExternalFields: [],
      })),
    };

    const result = await formContextProvider.get(
      makeRuntime(formService),
      makeMessage("hello"),
      {},
    );

    expect(result.text).toContain("form_context_json:");
    expect(result.text).toContain('"required_missing": [');
    expect(result.text).toContain("stashed_forms_json:");
    expect(result.text).not.toContain("# Active Form");
    expect(result.text).not.toContain("- Email");
    expect(result.values?.formContext).toBe(result.text);
  });
});

describe("FORM_RESTORE action", () => {
  it("restores the newest stashed form and invokes the callback", async () => {
    const stashed = makeSession({ id: "stashed", status: "stashed" });
    const restored = makeSession({ id: "restored", status: "active" });
    const formService = {
      getActiveSession: vi.fn(async () => null),
      getStashedSessions: vi.fn(async () => [stashed]),
      restore: vi.fn(async () => restored),
      getForm: vi.fn(() => signupForm),
      getSessionContext: vi.fn(() => ({
        hasActiveForm: true,
        formId: signupForm.id,
        formName: signupForm.name,
        progress: 50,
        filledFields: [
          {
            key: "name",
            label: "Name",
            displayValue: "Jane",
          },
        ],
        missingRequired: [],
        uncertainFields: [],
        nextField: signupForm.controls[1],
        status: "active",
        pendingExternalFields: [],
      })),
    };
    const runtime = makeRuntime(formService);
    const message = makeMessage("resume my form");
    const callback = vi.fn();

    await expect(
      formRestoreAction.validate(runtime, message, {}),
    ).resolves.toBe(true);
    const result = await formRestoreAction.handler(
      runtime,
      message,
      {},
      {},
      callback,
    );

    expect(result.success).toBe(true);
    expect(formService.restore).toHaveBeenCalledWith("stashed", entityId);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('I\'ve restored your "Signup" form.'),
      }),
    );
  });
});

describe("form_evaluator", () => {
  it("extracts values from JSON model output and updates the active session", async () => {
    const session = makeSession();
    const formService = {
      getActiveSession: vi.fn(async () => session),
      getStashedSessions: vi.fn(async () => []),
      getForm: vi.fn(() => signupForm),
      updateField: vi.fn(async () => undefined),
      saveSession: vi.fn(async () => undefined),
    };
    const runtime = makeRuntime(
      formService,
      JSON.stringify({
        intent: "fill_form",
        extractions: [
          {
            key: "email",
            value: "jane@example.com",
            confidence: 0.95,
            reasoning: "user gave email",
            is_correction: false,
          },
        ],
      }),
    );
    const message = makeMessage("my email is jane@example.com");

    await expect(formEvaluator.validate(runtime, message, {})).resolves.toBe(
      true,
    );
    await formEvaluator.handler(runtime, message, {});

    expect(runtime.useModel).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        prompt: expect.stringContaining(
          '"fields": [',
        ),
      }),
    );
    const prompt = runtime.useModel.mock.calls[0]?.[1]?.prompt as string;
    expect(prompt).toContain("Return only a valid JSON object");
    expect(prompt).not.toContain("```json");
    expect(prompt).not.toContain("FIELDS TO EXTRACT");
    expect(formService.updateField).toHaveBeenCalledWith(
      "session-1",
      entityId,
      "email",
      "jane@example.com",
      0.95,
      "extraction",
      message.id,
    );
  });
});
