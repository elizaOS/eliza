/**
 * Exercises agent-surface registration and DOM interaction against a real
 * jsdom-rendered provider rather than registry-only mocks.
 */
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSurfaceProvider } from "./AgentSurfaceContext";
import { handleAgentSurfaceCapability } from "./capabilities";
import { AgentButton, AgentInput } from "./components";
import { getViewRegistry } from "./registry";
import type { AgentElementSnapshot } from "./types";
import { useAgentElement } from "./useAgentElement";

afterEach(cleanup);

const VIEW = "integration-view";

describe("agent-surface render integration", () => {
  it("registers components and drives them through the capability bridge", () => {
    const onSwap = vi.fn();
    const onChange = vi.fn();

    function Fixture() {
      return (
        <AgentSurfaceProvider viewId={VIEW} viewType="gui">
          <AgentButton agentId="swap" onClick={onSwap}>
            Swap
          </AgentButton>
          <AgentInput
            agentId="amount"
            agentLabel="Amount"
            defaultValue=""
            onChange={onChange}
          />
        </AgentSurfaceProvider>
      );
    }

    render(<Fixture />);

    const registry = getViewRegistry(VIEW, "gui");
    expect(registry).toBeDefined();
    if (!registry) throw new Error("registry missing");

    // list-elements sees both controls with their labels/roles.
    const elements = handleAgentSurfaceCapability(
      registry,
      "list-elements",
      undefined,
    ) as AgentElementSnapshot[];
    expect(elements.map((e) => e.id).sort()).toEqual(["amount", "swap"]);
    expect(elements.find((e) => e.id === "swap")?.label).toBe("Swap");
    expect(
      document
        .querySelector("[data-agent-id='amount']")
        ?.getAttribute("aria-label"),
    ).toBe("Amount");

    // agent-fill drives the real <input>, firing React's onChange.
    handleAgentSurfaceCapability(registry, "agent-fill", {
      id: "amount",
      value: "12.5",
    });
    expect(onChange).toHaveBeenCalled();

    // agent-click fires the button handler.
    handleAgentSurfaceCapability(registry, "agent-click", { id: "swap" });
    expect(onSwap).toHaveBeenCalledOnce();
  });

  it("drives a controlled input through an onFill handler", () => {
    // The hook must run *under* the provider, so it lives in a child component.
    function ControlledInner() {
      const [value, setValue] = useState("");
      const { ref, agentProps } = useAgentElement<HTMLInputElement>({
        id: "note",
        role: "text-input",
        label: "Note",
        getValue: () => value,
        onFill: setValue,
      });
      return (
        <>
          <input ref={ref} value={value} readOnly {...agentProps} />
          <output data-testid="mirror">{value}</output>
        </>
      );
    }
    render(
      <AgentSurfaceProvider viewId={VIEW} viewType="gui">
        <ControlledInner />
      </AgentSurfaceProvider>,
    );

    const registry = getViewRegistry(VIEW, "gui");
    if (!registry) throw new Error("registry missing");
    const result = handleAgentSurfaceCapability(registry, "agent-fill", {
      id: "note",
      value: "hello",
    });
    expect(result).toMatchObject({ ok: true, id: "note", value: "hello" });
  });

  it("stamps explicit sensitive state and blocks password fills", () => {
    function SensitiveInner() {
      const { ref, agentProps } = useAgentElement<HTMLInputElement>({
        id: "owner-password",
        role: "text-input",
        label: "Owner password",
        sensitive: true,
      });
      return (
        <input
          ref={ref}
          type="password"
          defaultValue="existing"
          {...agentProps}
        />
      );
    }
    render(
      <AgentSurfaceProvider viewId={VIEW} viewType="gui">
        <SensitiveInner />
      </AgentSurfaceProvider>,
    );

    const registry = getViewRegistry(VIEW, "gui");
    if (!registry) throw new Error("registry missing");
    const element = document.querySelector<HTMLInputElement>(
      "[data-agent-id='owner-password']",
    );
    expect(element?.getAttribute("data-agent-sensitive")).toBe("true");
    const result = handleAgentSurfaceCapability(registry, "agent-fill", {
      id: "owner-password",
      value: "changed",
    });
    expect(result).toMatchObject({
      ok: false,
      id: "owner-password",
    });
    expect(element?.value).toBe("existing");
  });

  it("tears down the registry when the view unmounts", () => {
    const { unmount } = render(
      <AgentSurfaceProvider viewId="ephemeral" viewType="gui">
        <AgentButton agentId="x">X</AgentButton>
      </AgentSurfaceProvider>,
    );
    expect(getViewRegistry("ephemeral", "gui")).toBeDefined();
    unmount();
    expect(getViewRegistry("ephemeral", "gui")).toBeUndefined();
  });

  it("keeps controls attached to the bridged registry during Strict Mode effect replay", () => {
    const { unmount } = render(
      <StrictMode>
        <AgentSurfaceProvider viewId="strict-replay" viewType="gui">
          <AgentButton agentId="wallet-tab">Wallet tab</AgentButton>
        </AgentSurfaceProvider>
      </StrictMode>,
    );

    const registry = getViewRegistry("strict-replay", "gui");
    expect(registry).toBeDefined();
    expect(registry?.snapshot().elements.map(({ id }) => id)).toEqual([
      "wallet-tab",
    ]);

    unmount();
    expect(getViewRegistry("strict-replay", "gui")).toBeUndefined();
  });

  it("keeps a shared registry live until the last overlapping provider unmounts", () => {
    const { rerender, unmount } = render(
      <>
        <AgentSurfaceProvider key="first" viewId="overlap" viewType="gui">
          <AgentButton agentId="first">First</AgentButton>
        </AgentSurfaceProvider>
        <AgentSurfaceProvider key="second" viewId="overlap" viewType="gui">
          <AgentButton agentId="second">Second</AgentButton>
        </AgentSurfaceProvider>
      </>,
    );

    expect(
      getViewRegistry("overlap", "gui")
        ?.snapshot()
        .elements.map(({ id }) => id)
        .sort(),
    ).toEqual(["first", "second"]);

    rerender(
      <AgentSurfaceProvider key="second" viewId="overlap" viewType="gui">
        <AgentButton agentId="second">Second</AgentButton>
      </AgentSurfaceProvider>,
    );
    expect(
      getViewRegistry("overlap", "gui")
        ?.snapshot()
        .elements.map(({ id }) => id),
    ).toEqual(["second"]);

    unmount();
    expect(getViewRegistry("overlap", "gui")).toBeUndefined();
  });

  it("toggles highlight mode via the set-highlight capability", () => {
    render(
      <AgentSurfaceProvider viewId={VIEW} viewType="gui">
        <AgentButton agentId="go">Go</AgentButton>
      </AgentSurfaceProvider>,
    );
    const registry = getViewRegistry(VIEW, "gui");
    if (!registry) throw new Error("registry missing");
    expect(registry.isHighlighting()).toBe(false);
    handleAgentSurfaceCapability(registry, "set-highlight", { on: true });
    expect(registry.isHighlighting()).toBe(true);
  });
});
