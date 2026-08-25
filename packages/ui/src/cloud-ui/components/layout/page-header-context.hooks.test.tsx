/**
 * Unit coverage for the page-header context hooks: the context's missing-provider
 * default, usePageHeader's contract, and useSetPageHeader's publish / clear /
 * unmount-cleanup / reference-stabilisation behaviour, driven through a real
 * PageHeaderProvider and asserted on what consumers actually receive.
 */
// @vitest-environment jsdom

import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ReactNode, useContext, useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageHeaderProvider } from "./page-header-context";
import {
  PageHeaderContext,
  type PageHeaderInfo,
  usePageHeader,
  useSetPageHeader,
} from "./page-header-context.hooks";

afterEach(cleanup);

/** Reads the published header from the nearest provider for DOM assertions. */
function Probe() {
  const { pageInfo } = usePageHeader();
  return (
    <div>
      <span data-testid="probe-title">{pageInfo?.title ?? "none"}</span>
      <span data-testid="probe-description">
        {pageInfo?.description ?? "none"}
      </span>
      <span data-testid="probe-actions">{pageInfo?.actions ?? "none"}</span>
    </div>
  );
}

function Setter({ info }: { info: PageHeaderInfo | null }) {
  useSetPageHeader(info);
  return null;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <PageHeaderProvider>{children}</PageHeaderProvider>
);

describe("PageHeaderContext", () => {
  it("defaults to undefined so consumers can detect a missing provider", () => {
    const { result } = renderHook(() => useContext(PageHeaderContext));
    expect(result.current).toBeUndefined();
  });
});

describe("usePageHeader", () => {
  it("throws with the documented message outside a PageHeaderProvider", () => {
    // React logs the render error; silence it so the suite output stays clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => usePageHeader())).toThrow(
      "usePageHeader must be used within a PageHeaderProvider",
    );
    spy.mockRestore();
  });

  it("exposes a null pageInfo and a setter inside a PageHeaderProvider", () => {
    const { result } = renderHook(() => usePageHeader(), { wrapper });
    expect(result.current.pageInfo).toBeNull();
    expect(typeof result.current.setPageInfo).toBe("function");
  });
});

describe("useSetPageHeader", () => {
  it("publishes title, description, and actions to the provider", async () => {
    render(
      <PageHeaderProvider>
        <Setter
          info={{
            title: "Overview",
            description: "Account overview",
            actions: <button type="button">New key</button>,
          }}
        />
        <Probe />
      </PageHeaderProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe("Overview"),
    );
    expect(screen.getByTestId("probe-description").textContent).toBe(
      "Account overview",
    );
    expect(screen.getByRole("button", { name: "New key" })).toBeTruthy();
  });

  it("clears the header when called with null", async () => {
    const view = (info: PageHeaderInfo | null) => (
      <PageHeaderProvider>
        <Setter info={info} />
        <Probe />
      </PageHeaderProvider>
    );

    const { rerender } = render(view({ title: "Temp" }));
    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe("Temp"),
    );

    await rerender(view(null));
    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe("none"),
    );
  });

  it("normalises an omitted description and actions to undefined", () => {
    const { result } = renderHook(
      () => {
        useSetPageHeader({ title: "Bare" });
        return usePageHeader();
      },
      { wrapper },
    );

    expect(result.current.pageInfo?.title).toBe("Bare");
    expect(result.current.pageInfo?.description).toBeUndefined();
    expect(result.current.pageInfo?.actions).toBeUndefined();
  });

  it("publishes an empty-string title instead of clearing the header", async () => {
    render(
      <PageHeaderProvider>
        <Setter info={{ title: "" }} />
        <Probe />
      </PageHeaderProvider>,
    );

    // Only a nullish title takes the clear branch; "" is still a title.
    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe(""),
    );
  });

  it("updates the published header when the title changes", async () => {
    const view = (title: string) => (
      <PageHeaderProvider>
        <Setter info={{ title, description: `${title} body` }} />
        <Probe />
      </PageHeaderProvider>
    );

    const { rerender } = render(view("First"));
    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe("First"),
    );

    await rerender(view("Second"));
    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe("Second"),
    );
    expect(screen.getByTestId("probe-description").textContent).toBe(
      "Second body",
    );
  });

  it("clears the header when the calling component unmounts", async () => {
    const view = (showSetter: boolean) => (
      <PageHeaderProvider>
        {showSetter ? (
          <Setter key="setter" info={{ title: "Ephemeral" }} />
        ) : null}
        <Probe />
      </PageHeaderProvider>
    );

    const { rerender } = render(view(true));
    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe("Ephemeral"),
    );

    // The provider stays mounted; only the setter unmounts, so this isolates
    // the hook's own cleanup rather than teardown of the whole tree.
    await rerender(view(false));
    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe("none"),
    );
  });

  it("re-runs on caller dep changes even when title and description are unchanged", async () => {
    function ActionsSetter({ tick }: { tick: number }) {
      // actions flows through the hook's ref at effect time; bumping `deps`
      // is the documented way to republish a changed node with equal text fields.
      useSetPageHeader(
        { title: "Wallet", description: "Balances", actions: `action ${tick}` },
        [tick],
      );
      return null;
    }

    const view = (tick: number) => (
      <PageHeaderProvider>
        <ActionsSetter tick={tick} />
        <Probe />
      </PageHeaderProvider>
    );

    const { rerender } = render(view(0));
    await waitFor(() =>
      expect(screen.getByTestId("probe-actions").textContent).toBe("action 0"),
    );

    await rerender(view(1));
    await waitFor(() =>
      expect(screen.getByTestId("probe-actions").textContent).toBe("action 1"),
    );
    expect(screen.getByTestId("probe-title").textContent).toBe("Wallet");
  });

  it("does not republish across parent re-renders that pass fresh inline literals", async () => {
    const identities: Array<PageHeaderInfo | null> = [];

    /** Records each distinct pageInfo reference consumers actually observe. */
    function IdentityRecorder() {
      const { pageInfo } = usePageHeader();
      useEffect(() => {
        if (identities[identities.length - 1] !== pageInfo) {
          identities.push(pageInfo);
        }
      });
      return null;
    }

    function InlineLiteralSetter({ trigger }: { trigger: number }) {
      // A brand-new object literal on every render — the documented
      // infinite-re-render hazard this hook exists to prevent.
      useSetPageHeader({ title: "Stable", description: "same" });
      return <span data-testid="trigger">{trigger}</span>;
    }

    const view = (trigger: number) => (
      <PageHeaderProvider>
        <InlineLiteralSetter trigger={trigger} />
        <IdentityRecorder />
      </PageHeaderProvider>
    );

    const { rerender } = render(view(0));
    // The recorder also observes the pre-publish null; only non-null entries
    // are publishes.
    await waitFor(() =>
      expect(identities.filter((info) => info !== null).length).toBe(1),
    );
    await rerender(view(1));
    await rerender(view(2));

    // One publish for the mount; the repeated fresh literals cause none.
    expect(identities.filter((info) => info !== null).length).toBe(1);
    expect(identities[identities.length - 1]?.title).toBe("Stable");
  });
});
