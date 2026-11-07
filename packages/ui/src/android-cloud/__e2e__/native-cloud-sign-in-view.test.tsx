// @vitest-environment jsdom
/**
 * Eliza's native Android Cloud sign-in screens against a mocked
 * `NativeCloudSignInPort`: readiness decides which methods show, the email,
 * SMS and Google paths, a second factor, failure copy, cancel and the restart
 * announcement. No Android, Eliza Cloud or Google is involved.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../../i18n/index";
import { seedAppValue } from "../../state/app-store";
import type { AppContextValue } from "../../state/types";
import {
  AndroidNativeCloudSignInHost,
  AndroidNativeCloudSignInView,
} from "../AndroidNativeCloudSignInView";
import {
  type ElizaNativeCloudSignInPort,
  requestAndroidNativeCloudSignIn,
  resetAndroidNativeCloudSignInForTesting,
} from "../native-cloud-sign-in";

const ATTEMPT = "6f1c2c63-6d7a-4bd6-9b6c-1f2d3e4a5b6c";
const later = (ms: number) => Date.now() + ms;
const authenticated = (environment = "production") => ({
  status: "authenticated",
  environment,
  expiresAt: later(60_000),
  accountCreated: true,
});

type MockPort = ElizaNativeCloudSignInPort & {
  emit(event: string, value: unknown): void;
};

function mockPort(
  readiness: unknown = {
    inApp: true,
    methodsKnown: true,
    email: true,
    phone: true,
    google: true,
  },
): MockPort {
  const listeners = new Map<string, (value: unknown) => void>();
  const port = {
    status: vi.fn(async () => readiness),
    startGoogle: vi.fn(async () => authenticated()),
    startEmail: vi.fn(async () => ({
      attemptId: ATTEMPT,
      expiresAt: later(600_000),
      resendAt: later(60_000),
    })),
    startPhone: vi.fn(async () => ({
      attemptId: ATTEMPT,
      expiresAt: later(600_000),
      resendAt: later(60_000),
    })),
    verifyEmail: vi.fn(async () => authenticated()),
    verifyPhone: vi.fn(async () => authenticated()),
    verifyMfa: vi.fn(async () => authenticated()),
    resumeMfa: vi.fn(),
    cancel: vi.fn(async () => {}),
    addListener: vi.fn(
      async (event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener);
        return { remove: async () => listeners.delete(event) };
      },
    ),
    emit(event: string, value: unknown) {
      listeners.get(event)?.(value);
    },
  };
  return port as unknown as MockPort;
}

function renderView(port: MockPort, environment = "production" as const) {
  const onAuthenticated = vi.fn();
  const onAbandon = vi.fn();
  render(
    <AndroidNativeCloudSignInView
      request={{ id: 1, environment }}
      port={port}
      onAuthenticated={onAuthenticated}
      onAbandon={onAbandon}
    />,
  );
  return { onAuthenticated, onAbandon };
}

beforeEach(() => {
  seedAppValue({ t: createTranslator("en") } as AppContextValue);
});
afterEach(() => {
  cleanup();
  resetAndroidNativeCloudSignInForTesting();
});

describe("AndroidNativeCloudSignInView", () => {
  it("offers exactly the methods the native host reports as ready", async () => {
    const port = mockPort({
      inApp: true,
      methodsKnown: true,
      email: true,
      phone: false,
      google: false,
    });
    renderView(port);
    await screen.findByTestId("native-cloud-sign-in-email");
    expect(port.status).toHaveBeenCalledWith({
      environment: "production",
      refreshNegative: false,
    });
    expect(screen.queryByTestId("native-cloud-sign-in-google")).toBeNull();
    expect(screen.queryByTestId("native-cloud-sign-in-phone")).toBeNull();
  });

  it("keeps email and a retry when readiness is unknown, and re-checks on request", async () => {
    const port = mockPort({ inApp: false });
    renderView(port);
    await screen.findByTestId("native-cloud-sign-in-email");
    expect(screen.queryByTestId("native-cloud-sign-in-google")).toBeNull();
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-retry"));
    await waitFor(() =>
      expect(port.status).toHaveBeenLastCalledWith({
        environment: "production",
        refreshNegative: true,
      }),
    );
  });

  it("signs in with an emailed code", async () => {
    const port = mockPort();
    const { onAuthenticated } = renderView(port);
    fireEvent.change(await screen.findByTestId("native-cloud-sign-in-email"), {
      target: { value: " owner@example.com " },
    });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-email-send"));
    const codeField = await screen.findByTestId("native-cloud-sign-in-code");
    expect(port.startEmail).toHaveBeenCalledWith({
      environment: "production",
      email: "owner@example.com",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    // A resend waits for the cooldown the native host reported.
    expect(
      (screen.getByTestId("native-cloud-sign-in-resend") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(codeField, { target: { value: "123 456" } });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-verify"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(port.verifyEmail).toHaveBeenCalledWith({
      attemptId: ATTEMPT,
      code: "123456",
    });
    expect(onAuthenticated.mock.calls[0][0]).toMatchObject({
      status: "authenticated",
    });
  });

  it("signs in with a texted code and completes a second factor", async () => {
    const port = mockPort();
    vi.mocked(port.verifyPhone!).mockResolvedValueOnce({
      status: "mfa",
      method: "totp",
      expiresAt: later(300_000),
      attemptId: ATTEMPT,
      environment: "production",
    });
    const { onAuthenticated } = renderView(port);
    fireEvent.change(await screen.findByTestId("native-cloud-sign-in-phone"), {
      target: { value: "+14155550100" },
    });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-phone-send"));
    fireEvent.change(await screen.findByTestId("native-cloud-sign-in-code"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-verify"));
    await waitFor(() => expect(port.verifyPhone).toHaveBeenCalled());
    // The second-factor step replaces the code step.
    await waitFor(() =>
      expect(screen.queryByTestId("native-cloud-sign-in-resend")).toBeNull(),
    );
    fireEvent.change(screen.getByTestId("native-cloud-sign-in-code"), {
      target: { value: "111222" },
    });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-verify"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(port.verifyMfa).toHaveBeenCalledWith({
      attemptId: ATTEMPT,
      code: "111222",
    });
  });

  it("refuses a malformed address, number or code locally with fixed copy", async () => {
    const port = mockPort();
    renderView(port);
    fireEvent.change(await screen.findByTestId("native-cloud-sign-in-phone"), {
      target: { value: "4155550100" },
    });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-phone-send"));
    expect(
      (await screen.findByTestId("native-cloud-sign-in-error")).textContent,
    ).toContain("country code");
    expect(port.startPhone).not.toHaveBeenCalled();
  });

  it("shows owner-facing copy for a native failure and never the server text", async () => {
    const port = mockPort();
    vi.mocked(port.verifyEmail).mockRejectedValueOnce(
      Object.assign(new Error("steward said: secret detail"), {
        code: "invalid-code",
      }),
    );
    const { onAuthenticated } = renderView(port);
    fireEvent.change(await screen.findByTestId("native-cloud-sign-in-email"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-email-send"));
    fireEvent.change(await screen.findByTestId("native-cloud-sign-in-code"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-verify"));
    const error = await screen.findByTestId("native-cloud-sign-in-error");
    expect(error.textContent).toBe(
      "That code did not work. Check it and try again, or send a new code.",
    );
    expect(error.textContent).not.toContain("secret");
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("keeps a Google second factor unauthenticated until the native MFA verification succeeds", async () => {
    const port = mockPort();
    vi.mocked(port.startGoogle).mockResolvedValue({ status: "mfa", environment: "production", attemptId: ATTEMPT, method: "totp", expiresAt: later(300_000) });
    const { onAuthenticated } = renderView(port);
    fireEvent.click(await screen.findByTestId("native-cloud-sign-in-google"));
    const code = await screen.findByTestId("native-cloud-sign-in-code");
    expect(onAuthenticated).not.toHaveBeenCalled();
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-verify"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
  });

  it("signs in with the native Google account picker", async () => {
    const port = mockPort();
    const { onAuthenticated } = renderView(port);
    fireEvent.click(await screen.findByTestId("native-cloud-sign-in-google"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(port.startGoogle).toHaveBeenCalledWith({
      environment: "production",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("does not activate a late Google answer after its sign-in view is retired", async () => {
    const port = mockPort();
    let finish!: (value: unknown) => void;
    port.startGoogle = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { onAuthenticated } = renderView(port);
    fireEvent.click(await screen.findByTestId("native-cloud-sign-in-google"));
    await waitFor(() => expect(port.startGoogle).toHaveBeenCalledOnce());
    cleanup();
    await act(async () => { finish(authenticated()); });
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("revalidates a retained MFA challenge using the native active acknowledgement", async () => {
    const port = mockPort();
    port.startGoogle = vi.fn(() => new Promise(() => {}));
    vi.mocked(port.resumeMfa!).mockResolvedValue({ active: true });
    const { onAuthenticated } = renderView(port);
    await waitFor(() => expect(port.addListener).toHaveBeenCalledTimes(3));
    fireEvent.click(await screen.findByTestId("native-cloud-sign-in-google"));
    await waitFor(() => expect(port.startGoogle).toHaveBeenCalledOnce());
    await act(async () => port.emit("signInMfaRequired", {
      status: "mfa", environment: "production", attemptId: ATTEMPT,
      requestId: vi.mocked(port.startGoogle).mock.calls[0][0].requestId,
      method: "totp", expiresAt: later(300_000),
    }));
    const code = await screen.findByTestId("native-cloud-sign-in-code");
    expect(port.resumeMfa).toHaveBeenCalledWith({ attemptId: ATTEMPT, environment: "production" });
    expect(onAuthenticated).not.toHaveBeenCalled();
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-verify"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
  });

  it("can verify a retained MFA return when the original Google call never answers", async () => {
    const port = mockPort();
    let lateGoogle!: (value: unknown) => void;
    port.startGoogle = vi.fn(() => new Promise(resolve => { lateGoogle = resolve; }));
    vi.mocked(port.resumeMfa!).mockResolvedValue({ active: true });
    const { onAuthenticated } = renderView(port);
    fireEvent.click(await screen.findByTestId("native-cloud-sign-in-google"));
    await waitFor(() => expect(port.startGoogle).toHaveBeenCalledOnce());
    await act(async () => port.emit("signInMfaRequired", {
      status: "mfa", environment: "production", attemptId: ATTEMPT,
      requestId: vi.mocked(port.startGoogle).mock.calls[0][0].requestId,
      method: "totp", expiresAt: later(300_000),
    }));
    const code = await screen.findByTestId("native-cloud-sign-in-code");
    fireEvent.change(code, { target: { value: "123456" } });
    expect((screen.getByTestId("native-cloud-sign-in-verify") as HTMLButtonElement).disabled).toBe(false);
    // The superseded renderer callback cannot authenticate the still-unverified MFA attempt.
    await act(async () => { lateGoogle(authenticated()); });
    expect(onAuthenticated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-verify"));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(port.verifyMfa).toHaveBeenCalledWith({ attemptId: ATTEMPT, code: "123456" });
    expect(port.cancel).not.toHaveBeenCalled();
  });

  it("keeps an in-flight attempt when the host rerenders its callbacks", async () => {
    const port = mockPort();
    const earlier = vi.fn(), latest = vi.fn();
    let finish!: (value: unknown) => void;
    port.startGoogle = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<AndroidNativeCloudSignInView request={{ id: 1, environment: "production" }} port={port} onAuthenticated={earlier} />);
    fireEvent.click(await screen.findByTestId("native-cloud-sign-in-google"));
    await waitFor(() => expect(port.startGoogle).toHaveBeenCalledOnce());
    view.rerender(<AndroidNativeCloudSignInView request={{ id: 1, environment: "production" }} port={port} onAuthenticated={latest} />);
    await act(async () => { finish(authenticated()); });
    expect(latest).toHaveBeenCalledOnce();
    expect(earlier).not.toHaveBeenCalled();
    expect(port.cancel).not.toHaveBeenCalled();
  });

  it("cancels the native attempt and reports the owner left", async () => {
    const port = mockPort();
    const { onAbandon, onAuthenticated } = renderView(port);
    const email = await screen.findByTestId("native-cloud-sign-in-email");
    fireEvent.change(email, { target: { value: "owner@example.invalid" } });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-email-send"));
    await screen.findByTestId("native-cloud-sign-in-code");
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-cancel"));
    expect(port.cancel).toHaveBeenCalledTimes(1);
    await screen.findByTestId("native-cloud-sign-in-email");
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-cancel"));
    await waitFor(() => expect(onAbandon).toHaveBeenCalledTimes(1));
    expect(onAbandon.mock.calls[0][0]).toMatchObject({ code: "cancelled" });
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("keeps the owner mounted when cancel is unacknowledged and rejects its retained completion", async () => {
    const port = mockPort();
    vi.mocked(port.cancel).mockRejectedValue(new Error("bridge acknowledgement lost"));
    const { onAbandon, onAuthenticated } = renderView(port);
    const email = await screen.findByTestId("native-cloud-sign-in-email");
    fireEvent.change(email, { target: { value: "owner@example.invalid" } });
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-email-send"));
    await screen.findByTestId("native-cloud-sign-in-code");
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-cancel"));
    await screen.findByTestId("native-cloud-sign-in-error");
    expect(onAbandon).not.toHaveBeenCalled();
    const requestId = vi.mocked(port.startEmail).mock.calls[0][0].requestId;
    await act(async () => port.emit("signInCompleted", { ...authenticated(), requestId, attemptId: ATTEMPT, credentialId: ATTEMPT }));
    expect(onAuthenticated).not.toHaveBeenCalled();
    vi.mocked(port.cancel).mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-cancel"));
    await screen.findByTestId("native-cloud-sign-in-email");
    fireEvent.click(screen.getByTestId("native-cloud-sign-in-cancel"));
    await waitFor(() => expect(onAbandon).toHaveBeenCalledOnce());
    expect(port.cancel).toHaveBeenCalledTimes(2);
  });

  it("ignores an unscoped native restart announcement on a fresh interactive request", async () => {
    const port = mockPort();
    const { onAuthenticated } = renderView(port);
    await waitFor(() => expect(port.addListener).toHaveBeenCalledTimes(3));
    act(() => port.emit("signInIncomplete", { code: "app-link-unverified" }));
    expect(
      (await screen.findByTestId("native-cloud-sign-in-error")).textContent,
    ).toContain("Eliza did not receive the sign-in from your browser");
    await act(async () => port.emit("signInCompleted", authenticated()));
    expect(onAuthenticated).not.toHaveBeenCalled();
  });
});

describe("AndroidNativeCloudSignInHost", () => {
  it("keeps the account activation error on the sign-in surface and retries without sending another code", async () => {
    const port = mockPort();
    const activate = vi.fn().mockRejectedValueOnce(new Error("private server detail")).mockResolvedValueOnce(undefined);
    render(<AndroidNativeCloudSignInHost port={port} fallback={<p>Session ready</p>} />);
    let signedIn!: Promise<unknown>;
    act(() => { signedIn = requestAndroidNativeCloudSignIn("production", activate); });
    fireEvent.click(await screen.findByTestId("native-cloud-sign-in-google"));
    await screen.findByRole("button", { name: "Retry connection" });
    expect(screen.queryByText("Session ready")).toBeNull();
    expect(screen.queryByText("private server detail")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await act(async () => { await signedIn; });
    expect(screen.getByText("Session ready")).toBeTruthy();
    expect(port.startGoogle).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("shows the fallback until a sign-in is requested, then settles the request", async () => {
    const port = mockPort();
    render(
      <AndroidNativeCloudSignInHost
        port={port}
        fallback={<p data-testid="fallback">waiting</p>}
      />,
    );
    expect(screen.getByTestId("fallback")).toBeTruthy();
    let signedIn!: Promise<unknown>;
    act(() => {
      signedIn = requestAndroidNativeCloudSignIn("production");
    });
    const google = await screen.findByTestId("native-cloud-sign-in-google");
    let outcome: unknown;
    await act(async () => {
      fireEvent.click(google);
      outcome = await signedIn;
    });
    expect(outcome).toMatchObject({
      status: "authenticated",
      environment: "production",
    });
    expect(screen.getByTestId("fallback")).toBeTruthy();
  });
});
