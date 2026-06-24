// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { memo, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeRenderCounter,
  type RenderCounter,
  RenderProbe,
  useRenderSpy,
} from "./render-counter";

afterEach(cleanup);

// A memoized leaf that records every render of ITSELF via useRenderSpy. memo
// means it only re-renders when its own props change by reference.
function makeLeaf(counter: RenderCounter) {
  return memo(function Leaf({ data }: { data: { label: string } }) {
    useRenderSpy(counter);
    return <span>{data.label}</span>;
  });
}

describe("render-counter tooling — proves it catches real re-renders", () => {
  it("RenderProbe counts the mount commit", () => {
    const counter = makeRenderCounter();
    render(
      <RenderProbe id="probe" counter={counter}>
        <span>hello</span>
      </RenderProbe>,
    );
    expect(counter.count).toBe(1);
    expect(counter.mounts).toBe(1);
    expect(counter.updates).toBe(0);
  });

  // The load-bearing proof: the counter must DISTINGUISH a child that correctly
  // skips re-render (stable props + memo) from one that wrongly re-renders
  // (new prop object every parent render). If the tool were larp (always
  // returns the mount count), the unstable assertion would fail; if it
  // over-counted, the stable assertion would fail. Both passing == the tool
  // measures real React commits and would FAIL a memoization regression.
  it("detects an unnecessary re-render and confirms a memoized one is skipped", () => {
    const stable = makeRenderCounter();
    const unstable = makeRenderCounter();
    const StableLeaf = makeLeaf(stable);
    const UnstableLeaf = makeLeaf(unstable);

    // The stable child's prop object is created ONCE (hoisted), so a parent
    // re-render passes the same reference → memo skips it.
    const STABLE_DATA = { label: "stable" };

    function Parent() {
      const [n, setN] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setN((v) => v + 1)}>
            bump {n}
          </button>
          <StableLeaf data={STABLE_DATA} />
          {/* New object literal every parent render → memo can't bail out. */}
          <UnstableLeaf data={{ label: "unstable" }} />
        </div>
      );
    }

    render(<Parent />);
    // Both mounted once.
    expect(stable.count).toBe(1);
    expect(unstable.count).toBe(1);

    // An unrelated parent state change re-renders Parent.
    fireEvent.click(screen.getByRole("button"));

    // The memoized child with a stable prop reference did NOT re-render…
    expect(stable.count).toBe(1);
    // …while the one fed a fresh object each render DID. The tool caught it.
    expect(unstable.count).toBe(2);
  });

  it("useRenderSpy counts every render of its host component", () => {
    const counter = makeRenderCounter();
    function Host() {
      const [n, setN] = useState(0);
      useRenderSpy(counter);
      return (
        <button type="button" onClick={() => setN((v) => v + 1)}>
          {n}
        </button>
      );
    }
    render(<Host />);
    expect(counter.count).toBe(1);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    expect(counter.count).toBe(3); // 1 mount + 2 state-driven renders
  });

  it("reset() lets a test count only post-interaction commits", () => {
    const counter = makeRenderCounter();
    function Host() {
      const [n, setN] = useState(0);
      useRenderSpy(counter);
      return (
        <button type="button" onClick={() => setN((v) => v + 1)}>
          {n}
        </button>
      );
    }
    render(<Host />);
    counter.reset(); // drop the mount
    fireEvent.click(screen.getByRole("button"));
    expect(counter.count).toBe(1); // exactly one re-render after reset
  });
});
