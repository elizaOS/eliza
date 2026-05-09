import type { AgentRuntime, Service } from "@elizaos/core";

type BrowserActionParams =
  | { action: "open" | "navigate"; url: string }
  | { action: "wait"; text?: string; selector?: string; timeout?: number }
  | { action: "click"; text?: string; selector?: string }
  | { action: "get_dom" | "screenshot" };

type BrowserActionResult = {
  success: boolean;
  message?: string | null;
  content?: string | null;
  url?: string | null;
  title?: string | null;
  error?: string | null;
  data?: Record<string, string | null>;
  screenshot?: string | null;
};

type BrowserPhase = "idle" | "opened" | "confirming" | "canceled";

const CANCEL_SELECTOR = "[data-lifeops-action='cancel-subscription']";
const CONFIRM_SELECTOR = "[data-lifeops-action='confirm-cancellation']";

export class FakeSubscriptionComputerUseService {
  private currentUrl: string | null = null;
  private phase: BrowserPhase = "idle";

  constructor(public readonly fixtureId: string) {}

  async executeBrowserAction(
    params: BrowserActionParams,
  ): Promise<BrowserActionResult> {
    switch (params.action) {
      case "open":
      case "navigate":
        this.currentUrl = params.url;
        this.phase = "opened";
        return this.result("opened fixture page");
      case "wait":
        return this.waitFor(params);
      case "click":
        return this.click(params);
      case "get_dom":
        return this.result("captured fixture DOM");
      case "screenshot":
        return {
          ...this.result("captured fixture screenshot"),
          screenshot: `fixture-screenshot:${this.fixtureId}:${this.phase}`,
        };
    }
  }

  private waitFor(
    params: Extract<BrowserActionParams, { action: "wait" }>,
  ): BrowserActionResult {
    if (params.text && !this.domText().includes(params.text.toLowerCase())) {
      return this.failure(`Text not found: ${params.text}`);
    }
    if (
      params.selector &&
      !this.availableSelectors().includes(params.selector)
    ) {
      return this.failure(`Selector not found: ${params.selector}`);
    }
    return this.result("wait matched fixture page");
  }

  private click(
    params: Extract<BrowserActionParams, { action: "click" }>,
  ): BrowserActionResult {
    const text = params.text?.toLowerCase() ?? null;
    if (text === "cancel subscription" || params.selector === CANCEL_SELECTOR) {
      this.phase = "confirming";
      return this.result("opened cancellation confirmation");
    }
    if (
      text === "confirm cancellation" ||
      params.selector === CONFIRM_SELECTOR
    ) {
      this.phase = "canceled";
      return this.result("confirmed cancellation");
    }
    return this.failure(
      `Unsupported fixture click: ${params.text ?? params.selector ?? "unknown"}`,
    );
  }

  private result(message: string): BrowserActionResult {
    return {
      success: true,
      message,
      content: this.dom(),
      url: this.currentUrl,
      title: this.title(),
      data: {
        fixtureId: this.fixtureId,
        phase: this.phase,
        url: this.currentUrl,
      },
    };
  }

  private failure(error: string): BrowserActionResult {
    return {
      success: false,
      message: error,
      error,
      content: this.dom(),
      url: this.currentUrl,
      title: this.title(),
      data: {
        fixtureId: this.fixtureId,
        phase: this.phase,
        url: this.currentUrl,
      },
    };
  }

  private domText(): string {
    return this.dom().toLowerCase();
  }

  private dom(): string {
    if (this.fixtureId === "fixture_login_required") {
      return [
        "<main>",
        `<h1>${this.title()}</h1>`,
        "<p>Sign in to continue</p>",
        "<label>Email address</label>",
        "</main>",
      ].join("");
    }
    if (this.phase === "canceled") {
      return [
        "<main>",
        `<h1>${this.title()}</h1>`,
        "<p>subscription canceled</p>",
        "</main>",
      ].join("");
    }
    if (this.phase === "confirming") {
      return [
        "<main>",
        `<h1>${this.title()}</h1>`,
        "<p>Confirm cancellation</p>",
        `<button data-lifeops-action="confirm-cancellation">Confirm cancellation</button>`,
        "</main>",
      ].join("");
    }
    return [
      "<main>",
      `<h1>${this.title()}</h1>`,
      "<h2>Subscriptions</h2>",
      `<button data-lifeops-action="cancel-subscription">Cancel subscription</button>`,
      "</main>",
    ].join("");
  }

  private availableSelectors(): string[] {
    if (this.phase === "confirming") {
      return [CONFIRM_SELECTOR];
    }
    if (this.fixtureId !== "fixture_login_required") {
      return [CANCEL_SELECTOR];
    }
    return [];
  }

  private title(): string {
    switch (this.fixtureId) {
      case "google_play":
        return "Google Play";
      case "fixture_login_required":
        return "Fixture Access Wall";
      case "fixture_streaming":
        return "Fixture Streaming";
      default:
        return "Fixture Subscription";
    }
  }
}

export function attachFakeSubscriptionComputerUse(
  runtime: AgentRuntime,
  svc: FakeSubscriptionComputerUseService = new FakeSubscriptionComputerUseService(
    "fixture_streaming",
  ),
): void {
  const runtimeWithServices = runtime as AgentRuntime & {
    getService: AgentRuntime["getService"];
  };
  const previousGetService = runtimeWithServices.getService.bind(runtime);
  runtimeWithServices.getService = (<T extends Service = Service>(
    serviceType: string,
  ): T | null => {
    if (serviceType === "computeruse") {
      return svc as T;
    }
    return previousGetService(serviceType) as T | null;
  }) as AgentRuntime["getService"];
}
