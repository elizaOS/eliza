import type {
  BrowserActionParams,
  BrowserActionResult,
} from "@elizaos/plugin-computeruse";

export type FakeSubscriptionScenario =
  | "google_play"
  | "apple_subscriptions"
  | "fixture_streaming"
  | "fixture_login_required"
  | "fixture_phone_only";

type ScenarioState = {
  cancelOpened: boolean;
  completed: boolean;
};

function scenarioForUrl(url: string): FakeSubscriptionScenario | null {
  const normalized = url.toLowerCase();
  if (normalized.includes("google.com/store/account/subscriptions")) {
    return "google_play";
  }
  if (
    normalized.includes(
      "account.apple.com/account/manage/section/subscriptions",
    )
  ) {
    return "apple_subscriptions";
  }
  if (
    normalized.includes("/services/netflix") ||
    normalized.includes("/services/hulu") ||
    normalized.includes("/services/fixture-streaming")
  ) {
    return "fixture_streaming";
  }
  if (normalized.includes("/services/login-required")) {
    return "fixture_login_required";
  }
  if (normalized.includes("/services/phone-only")) {
    return "fixture_phone_only";
  }
  return null;
}

function renderScenario(
  scenario: FakeSubscriptionScenario,
  state: ScenarioState,
): string {
  if (state.completed) {
    return "subscription canceled";
  }
  if (scenario === "fixture_login_required") {
    return "Sign in to continue";
  }
  if (scenario === "fixture_phone_only") {
    return "Call us to cancel";
  }
  if (state.cancelOpened) {
    return "Confirm cancellation Confirm cancellation";
  }
  return "Subscriptions Cancel subscription";
}

export class FakeSubscriptionComputerUseService {
  public readonly history: BrowserActionParams[] = [];
  public scenario: FakeSubscriptionScenario;
  private readonly state: ScenarioState = {
    cancelOpened: false,
    completed: false,
  };

  constructor(initialScenario: FakeSubscriptionScenario = "fixture_streaming") {
    this.scenario = initialScenario;
  }

  async executeBrowserAction(
    params: BrowserActionParams,
  ): Promise<BrowserActionResult> {
    this.history.push({ ...params });
    switch (params.action) {
      case "open":
      case "navigate": {
        const nextUrl = typeof params.url === "string" ? params.url : "";
        const nextScenario = scenarioForUrl(nextUrl);
        if (nextScenario) {
          this.scenario = nextScenario;
        }
        this.state.cancelOpened = false;
        this.state.completed = false;
        return {
          success: true,
          url: nextUrl,
          title: "Subscriptions",
          isOpen: true,
          is_open: true,
          content: renderScenario(this.scenario, this.state),
          message: `Opened ${nextUrl}`,
        };
      }
      case "wait":
        return {
          success: true,
          message: "wait satisfied",
          content: renderScenario(this.scenario, this.state),
        };
      case "get_dom":
      case "context":
      case "state":
        return {
          success: true,
          content: renderScenario(this.scenario, this.state),
          message: "page snapshot",
        };
      case "click": {
        const clickLabel =
          `${params.text ?? ""} ${params.selector ?? ""}`.toLowerCase();
        if (clickLabel.includes("confirm")) {
          this.state.completed = true;
        } else if (clickLabel.includes("cancel")) {
          this.state.cancelOpened = true;
        }
        return {
          success: true,
          content: renderScenario(this.scenario, this.state),
          message: "clicked",
        };
      }
      case "screenshot":
        return {
          success: true,
          screenshot: Buffer.from(
            `${this.scenario}:${this.history.length}`,
            "utf8",
          ).toString("base64"),
          message: "captured screenshot",
        };
      default:
        return {
          success: true,
          message: `noop ${params.action}`,
          content: renderScenario(this.scenario, this.state),
        };
    }
  }
}

export function attachFakeSubscriptionComputerUse(
  runtime: { getService?: (serviceType: string) => unknown },
  service = new FakeSubscriptionComputerUseService(),
): FakeSubscriptionComputerUseService {
  const originalGetService = runtime.getService?.bind(runtime);
  runtime.getService = ((serviceType: string) => {
    if (serviceType === "computeruse") {
      return service;
    }
    return originalGetService ? originalGetService(serviceType) : null;
  }) as typeof runtime.getService;
  return service;
}
