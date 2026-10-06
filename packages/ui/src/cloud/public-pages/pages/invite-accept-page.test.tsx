/** Session-readiness regression coverage for the public invite acceptance page. */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigateMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => vi.fn());
const sessionRef = vi.hoisted(() => ({
  current: { ready: false, authenticated: false },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams("token=invite-token")],
}));

vi.mock("../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionRef.current,
}));

vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
  ApiError: class ApiError extends Error {},
}));

vi.mock("../../shell/CloudI18nProvider", () => {
  // Match the provider's stable translator so validation settles after loading.
  const t = (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key;
  return { useCloudT: () => t };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

vi.mock("../../../components/ui/alert", () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { Alert: Container, AlertDescription: Container };
});
vi.mock("../../../components/ui/badge", () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { Badge: Container };
});
vi.mock("../../../components/ui/card", () => {
  const Container = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Card: Container,
    CardContent: Container,
    CardDescription: Container,
    CardHeader: Container,
    CardTitle: Container,
  };
});
vi.mock("../../../components/ui/button", () => {
  return {
    Button: ({
      children,
      disabled,
      onClick,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
  };
});

import InviteAcceptPage from "./invite-accept-page";

afterEach(cleanup);

beforeEach(() => {
  navigateMock.mockReset();
  apiMock.mockReset();
  sessionRef.current = { ready: false, authenticated: false };
  apiMock.mockResolvedValue({
    success: true,
    data: {
      organization_name: "Example Org",
      invited_email: "invitee@example.com",
      role: "member",
      expires_at: "2099-01-01T00:00:00.000Z",
      inviter_name: "Inviter",
    },
  });
});

// globals are off, so Testing Library does not auto-unmount; unmount before
// the jsdom environment is torn down so the pending invite load cannot
// schedule React work against a missing window.
afterEach(cleanup);

describe("InviteAcceptPage", () => {
  it("does not offer a sign-in action until session identity is ready", async () => {
    render(<InviteAcceptPage />);

    const action = await screen.findByRole("button", {
      name: /checking sign-in/i,
    });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock).toHaveBeenCalledTimes(1);

    fireEvent.click(action);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/invites/accept",
      expect.anything(),
    );
  });
});
