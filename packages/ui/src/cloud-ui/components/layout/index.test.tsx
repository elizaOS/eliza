/** Verifies the cloud dashboard layout barrel's exported component and hook behaviour. */
// @vitest-environment jsdom

/**
 * Verifies the consumer-visible behaviour behind src/cloud-ui/components/layout/index.ts by
 * rendering its exports the way cloud dashboard routes do: DashboardShellLayout's
 * sidebar/header/main scroll-region split, DashboardPageContainer's element and width
 * branches, the stack/toolbar/stat-grid primitives, DashboardHeader's chrome slots,
 * PageTransition's keyed route swaps, and EnsurePageHeaderProvider's defer-or-supply
 * choice between the app-shell provider and its own. Real components against jsdom.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DashboardHeader,
  DashboardPageContainer,
  DashboardPageStack,
  DashboardShellLayout,
  DashboardStatGrid,
  DashboardToolbar,
  EnsurePageHeaderProvider,
  PageHeaderProvider,
  PageTransition,
  usePageHeader,
  useSetPageHeader,
} from "./index";

afterEach(cleanup);

/** Reads the published header from the nearest provider for DOM assertions. */
function Probe() {
  const { pageInfo } = usePageHeader();
  return <span data-testid="probe-title">{pageInfo?.title ?? "none"}</span>;
}

function Setter({ title }: { title: string }) {
  useSetPageHeader({ title });
  return null;
}

describe("EnsurePageHeaderProvider", () => {
  it("supplies its own provider when no ancestor exists, so nested setters publish", async () => {
    render(
      <EnsurePageHeaderProvider>
        <Setter title="Standalone Route" />
        <Probe />
      </EnsurePageHeaderProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe(
        "Standalone Route",
      ),
    );
  });

  it("defers to an ancestor provider so inner writes reach the outer owner", async () => {
    // The probe sits OUTSIDE the ensure-wrapper: if the wrapper supplied its own
    // provider it would shadow the shell's context and this probe would stay null.
    render(
      <PageHeaderProvider>
        <Probe />
        <EnsurePageHeaderProvider>
          <Setter title="Shell Title" />
        </EnsurePageHeaderProvider>
      </PageHeaderProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("probe-title").textContent).toBe("Shell Title"),
    );
  });
});

describe("DashboardShellLayout", () => {
  it("mounts children in the scrolling main region identified as #main", () => {
    render(
      <DashboardShellLayout
        sidebar={<nav data-testid="shell-sidebar">nav</nav>}
        header={<div data-testid="shell-header">top</div>}
      >
        <p data-testid="shell-body">body</p>
      </DashboardShellLayout>,
    );

    const main = document.getElementById("main");
    expect(main).not.toBeNull();
    expect(main?.contains(screen.getByTestId("shell-body"))).toBe(true);
    expect(main?.className).toContain("overflow-y-auto");
  });

  it("keeps the sidebar and header outside the scrolling main region", () => {
    render(
      <DashboardShellLayout
        sidebar={<nav data-testid="shell-sidebar">nav</nav>}
        header={<div data-testid="shell-header">top</div>}
      >
        <p data-testid="shell-body">body</p>
      </DashboardShellLayout>,
    );

    const main = document.getElementById("main") as HTMLElement;
    expect(main.contains(screen.getByTestId("shell-sidebar"))).toBe(false);
    expect(main.contains(screen.getByTestId("shell-header"))).toBe(false);
    // Header sits above the content column; sidebar precedes it too.
    const header = screen.getByTestId("shell-header");
    expect(
      header.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("DashboardPageContainer", () => {
  it("defaults to a wide section-less div constrained to the wide max-width", () => {
    const { container } = render(
      <DashboardPageContainer>
        <p>content</p>
      </DashboardPageContainer>,
    );

    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain("max-w-[1400px]");
    expect(el.className).toContain("mx-auto");
  });

  it("honours the as element switch and narrow/full widths", () => {
    const { container } = render(
      <DashboardPageContainer as="section" width="narrow">
        <p>narrow</p>
      </DashboardPageContainer>,
    );
    const narrow = container.firstElementChild as HTMLElement;
    expect(narrow.tagName).toBe("SECTION");
    expect(narrow.className).toContain("max-w-5xl");

    const full = render(
      <DashboardPageContainer width="full">
        <p>full</p>
      </DashboardPageContainer>,
    ).container.firstElementChild as HTMLElement;
    expect(full.className).toContain("w-full");
    expect(full.className).not.toContain("mx-auto");
  });

  it("spreads host props and merges caller classes after the defaults", () => {
    const { container } = render(
      <DashboardPageContainer id="page-probe" className="caller-class">
        <p>x</p>
      </DashboardPageContainer>,
    );

    const el = container.firstElementChild as HTMLElement;
    expect(el.id).toBe("page-probe");
    expect(el.className).toContain("min-w-0");
    expect(el.className).toContain("caller-class");
  });
});

describe("DashboardPageStack", () => {
  it("renders the vertical stack rhythm and keeps caller classes", () => {
    const { container } = render(
      <DashboardPageStack className="extra-stack">
        <p>x</p>
      </DashboardPageStack>,
    );

    const el = container.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.className).toContain("flex-col");
    expect(el.className).toContain("gap-6");
    expect(el.className).toContain("extra-stack");
  });
});

describe("DashboardToolbar", () => {
  it("stacks on mobile and spreads across the row from the sm breakpoint", () => {
    const { container } = render(
      <DashboardToolbar>
        <p>left</p>
      </DashboardToolbar>,
    );

    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("flex-col");
    expect(el.className).toContain("sm:flex-row");
    expect(el.className).toContain("sm:justify-between");
  });
});

describe("DashboardStatGrid", () => {
  it("defaults to four columns", () => {
    const { container } = render(
      <DashboardStatGrid>
        <p>x</p>
      </DashboardStatGrid>,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "xl:grid-cols-4",
    );
  });

  it("maps columns={2} and columns={3} to their breakpoint ladders", () => {
    const two = render(
      <DashboardStatGrid columns={2}>
        <p>x</p>
      </DashboardStatGrid>,
    ).container.firstElementChild as HTMLElement;
    expect(two.className).toContain("sm:grid-cols-2");
    expect(two.className).not.toContain("xl:");

    const three = render(
      <DashboardStatGrid columns={3}>
        <p>x</p>
      </DashboardStatGrid>,
    ).container.firstElementChild as HTMLElement;
    expect(three.className).toContain("xl:grid-cols-3");
    expect(three.className).not.toContain("xl:grid-cols-4");
  });
});

describe("DashboardHeader", () => {
  it("renders the published title and action slot when pageInfo is set", () => {
    render(
      <DashboardHeader
        onToggleSidebar={() => {}}
        pageInfo={{
          title: "API Keys",
          actions: <button type="button">New key</button>,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "API Keys" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New key" })).toBeTruthy();
  });

  it("omits the title heading entirely when no pageInfo is provided", () => {
    render(<DashboardHeader onToggleSidebar={() => {}} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("wires the navigation toggle to the mobile menu button", () => {
    const onToggle = vi.fn();
    render(<DashboardHeader onToggleSidebar={onToggle} />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle navigation" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("shows the default sign-up CTA pointing at loginHref for anonymous users", () => {
    render(<DashboardHeader onToggleSidebar={() => {}} isAnonymous />);

    const cta = screen.getByRole("link", { name: /sign up/i });
    expect(cta.getAttribute("href")).toBe("/login");
  });

  it("prefers a caller-supplied anonymous CTA over the built-in one", () => {
    render(
      <DashboardHeader
        onToggleSidebar={() => {}}
        isAnonymous
        anonymousCta={<a href="/enter">Enter</a>}
        loginHref="/login"
      />,
    );

    expect(
      screen.getByRole("link", { name: "Enter" }).getAttribute("href"),
    ).toBe("/enter");
    expect(screen.queryByRole("link", { name: /sign up/i })).toBeNull();
  });

  it("swaps the anonymous CTA for rightContent once authenticated", () => {
    render(
      <DashboardHeader
        onToggleSidebar={() => {}}
        rightContent={<span data-testid="account-chip">acct</span>}
      />,
    );

    expect(screen.getByTestId("account-chip")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /sign up/i })).toBeNull();
  });
});

describe("PageTransition", () => {
  it("renders children through the animated wrapper with caller classes", () => {
    render(
      <PageTransition className="route-frame">
        <span data-testid="transition-body">content</span>
      </PageTransition>,
    );

    const body = screen.getByTestId("transition-body");
    expect(body.textContent).toBe("content");
    // The motion.div wrapper is the span's direct parent and carries the caller class.
    expect((body.parentElement as HTMLElement).className).toContain(
      "route-frame",
    );
  });

  it("swaps the subtree when the transition key (pathname) changes", async () => {
    const view = (pathname: string) => (
      <PageTransition pathname={pathname}>
        <span data-testid="transition-route">{pathname}</span>
      </PageTransition>
    );

    const { rerender } = render(view("/overview"));
    expect(screen.getByTestId("transition-route").textContent).toBe(
      "/overview",
    );

    // AnimatePresence mode="wait" retires the outgoing route before mounting
    // the next keyed child, so the swap settles asynchronously.
    await rerender(view("/wallet"));
    await waitFor(
      () =>
        expect(screen.getByTestId("transition-route").textContent).toBe(
          "/wallet",
        ),
      { timeout: 2000 },
    );
  });
});
