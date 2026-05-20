import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NextRequest } from "next/server";

const mockCheckRateLimitAsync = mock();
const mockGetClientIp = mock();
const mockSendModelPilotInquiryEmails = mock();

mock.module("@feed/api", () => ({
  checkRateLimitAsync: mockCheckRateLimitAsync,
  getClientIp: mockGetClientIp,
  RATE_LIMIT_CONFIGS: {
    MODEL_PILOT_INQUIRY: {
      maxRequests: 5,
      windowMs: 60_000,
      actionType: "model_pilot_inquiry",
    },
  },
  rateLimitError: (retryAfter?: number) =>
    new Response(JSON.stringify({ error: "rate_limited", retryAfter }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    }),
  sendModelPilotInquiryEmails: mockSendModelPilotInquiryEmails,
  successResponse: (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  withErrorHandling: (handler: (request: NextRequest) => Promise<Response>) =>
    handler,
}));

mock.module("@feed/shared", () => ({
  MODEL_PILOT_DELIVERABLES: [
    "Behavioral data",
    "Evaluation report",
    "Labeled dataset",
    "Fine-tuned model",
    "Dataset + fine-tuned model",
    "Ongoing retraining",
  ],
  MODEL_PILOT_SCENARIOS: [
    "Market manipulation",
    "Scam detection",
    "Multi-agent coordination",
    "Social engineering resistance",
    "Narrative volatility",
    "Custom scenarios",
  ],
  MODEL_PILOT_OUTPUTS: [
    "Raw logs",
    "Structured data",
    "Labeled data",
    "Evaluation report",
    "Fine-tuned model",
    "Hosted endpoint",
  ],
  MODEL_PILOT_REVIEW_LEVELS: ["Off", "Light review", "Full labeling support"],
}));

const { POST } = await import("./route");

const validBody = {
  email: " founder@example.com ",
  agreedToTerms: true as const,
  modelProvider: " Anthropic ",
  modelName: " Sonnet ",
  apiEndpoint: " https://api.example.com/model ",
  toolUse: true,
  memory: false,
  deliverables: ["Behavioral data"],
  scenarios: ["Scam detection"],
  outputs: ["Structured data"],
  concurrentAgents: 500,
  scenarioRuns: 10_000,
  humanReview: "Light review",
  privateDeployment: false,
  dataExclusivity: false,
};

function createRequest(
  body: unknown,
  options?: { jsonRejects?: boolean },
): NextRequest {
  return {
    headers: new Headers(),
    json: options?.jsonRejects
      ? () => Promise.reject(new Error("invalid json"))
      : () => Promise.resolve(body),
  } as unknown as NextRequest;
}

describe("POST /api/model-pilot-inquiry", () => {
  beforeEach(() => {
    mockCheckRateLimitAsync.mockReset();
    mockGetClientIp.mockReset();
    mockSendModelPilotInquiryEmails.mockReset();

    mockGetClientIp.mockReturnValue("203.0.113.5");
    mockCheckRateLimitAsync.mockResolvedValue({
      allowed: true,
      remaining: 4,
      retryAfter: 60,
    });
    mockSendModelPilotInquiryEmails.mockResolvedValue({ sent: true });
  });

  it("sends trimmed inquiry data for valid submissions", async () => {
    const response = await POST(createRequest(validBody));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(mockSendModelPilotInquiryEmails).toHaveBeenCalledWith({
      senderEmail: "founder@example.com",
      modelProvider: "Anthropic",
      modelName: "Sonnet",
      apiEndpoint: "https://api.example.com/model",
      toolUse: true,
      memory: false,
      deliverables: ["Behavioral data"],
      scenarios: ["Scam detection"],
      outputs: ["Structured data"],
      concurrentAgents: 500,
      scenarioRuns: 10000,
      humanReview: "Light review",
      privateDeployment: false,
      dataExclusivity: false,
    });
  });

  it("rejects malformed requests before email delivery", async () => {
    const response = await POST(
      createRequest({
        ...validBody,
        deliverables: [],
        scenarios: [],
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: "invalid_request" });
    expect(mockSendModelPilotInquiryEmails).not.toHaveBeenCalled();
  });

  it("returns rate limit errors from the IP guard", async () => {
    mockCheckRateLimitAsync.mockResolvedValue({
      allowed: false,
      retryAfter: 23,
    });

    const response = await POST(createRequest(validBody));
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(payload).toEqual({ error: "rate_limited", retryAfter: 23 });
    expect(mockSendModelPilotInquiryEmails).not.toHaveBeenCalled();
  });

  it("maps missing email provider config to 503", async () => {
    mockSendModelPilotInquiryEmails.mockResolvedValue({
      sent: false,
      reason: "provider_not_configured",
    });

    const response = await POST(createRequest(validBody));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: "email_delivery_failed",
      reason: "provider_not_configured",
    });
  });

  it("maps other delivery failures to 502", async () => {
    mockSendModelPilotInquiryEmails.mockResolvedValue({
      sent: false,
      reason: "send_failed",
    });

    const response = await POST(createRequest(validBody));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toEqual({
      error: "email_delivery_failed",
      reason: "send_failed",
    });
  });

  it("rejects invalid JSON bodies", async () => {
    const response = await POST(createRequest(null, { jsonRejects: true }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({ error: "invalid_request" });
  });
});
