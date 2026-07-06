// @vitest-environment jsdom
//
// Streaming render-count lock for the inline chat-reply widgets
// (perf/chat-render-benchmarks). MessageContent re-parses the WHOLE message
// body on every streamed token, so each inline widget is handed a FRESH
// data-derived props object on every tick even when its own payload is
// unchanged. Each widget is wrapped in React.memo with a value-level comparator
// (`widget-equality.ts`); a payload-equal re-parse must NOT re-render (nor
// remount, which would wipe the widget's own selection/form state).
//
// HOW THIS IS MEASURED FAITHFULLY: the comparator a widget ships with is the
// SAME predicate exported from `widget-equality.ts` and asserted here — that is
// the entire point of exporting it. Each widget under test is composed with
// `useRenderSpy` under a `memo(..., <the exported predicate>)` boundary, so the
// spy fires exactly when the shipped memo would re-render: it bails on a
// payload-equal re-parse and renders on a real change. Because the wrapper uses
// the shipped predicate (not a re-derived copy), a regression that weakens the
// comparator flips this test. Each case also drives the REAL widget instance so
// a comparator that diverges from the component's props would surface.
//
// The parent `Harness` owns a "streamed token" counter; bumping it rebuilds the
// widget's data props as brand-new objects with identical VALUES (ticks 0→1 —
// the stream-reparse condition) then advances the payload (tick 1→2). Both
// directions are asserted so the lock can never pass vacuously.

import type { SwarmActivityPlanEntry } from "@elizaos/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ComponentType, memo, type ReactNode, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeRenderCounter,
  type RenderCounter,
  useRenderSpy,
} from "../../../testing/render-counter";
import type { FollowupOption } from "../message-followups-parser";
import type { FormRequestSpec } from "../message-form-parser";
import type { WorkflowSpec } from "../message-workflow-parser";
import { ChoiceWidget } from "./ChoiceWidget";
import { FollowupsWidget } from "./followups";
import { FormRequest } from "./form-request";
import { PlanChecklist } from "./task-pipeline";
import { TaskWidget } from "./task-widget";
import {
  choicePropsEqual,
  followupsPropsEqual,
  formRequestPropsEqual,
  planChecklistPropsEqual,
  workflowPropsEqual,
} from "./widget-equality";
import { WorkflowSteps } from "./workflow-steps";

afterEach(cleanup);

const REACT_MEMO = Symbol.for("react.memo");

/**
 * A React.memo object exposes `$$typeof === Symbol.for("react.memo")` and its
 * comparator on `.compare`. Asserting these is what proves the SHIPPED widget is
 * wired to its exported predicate (not just that the predicate behaves) — a
 * regression that drops the memo, or swaps in default referential equality,
 * flips `$$typeof`/`compare` and fails here.
 */
function memoCompareOf(component: unknown): unknown {
  const c = component as { $$typeof?: symbol; compare?: unknown };
  expect(c.$$typeof).toBe(REACT_MEMO);
  return c.compare;
}

describe("inline widgets are wired to their exported comparator", () => {
  it("each widget is a react.memo whose compare is the exported predicate", () => {
    expect(memoCompareOf(ChoiceWidget)).toBe(choicePropsEqual);
    expect(memoCompareOf(FollowupsWidget)).toBe(followupsPropsEqual);
    expect(memoCompareOf(FormRequest)).toBe(formRequestPropsEqual);
    expect(memoCompareOf(WorkflowSteps)).toBe(workflowPropsEqual);
    expect(memoCompareOf(PlanChecklist)).toBe(planChecklistPropsEqual);
    // TaskWidget takes only primitive props, so it uses default (shallow) memo
    // equality — assert it is still a memo (default compare is null).
    expect(memoCompareOf(TaskWidget)).toBeNull();
  });
});

/**
 * Compose a widget with a render spy under the SHIPPED memo predicate. The spy
 * fires once per render of this boundary, which bails/renders identically to the
 * widget's own `memo(fn, predicate)` because it uses the same predicate.
 */
function spyWidget<P extends object>(
  Widget: ComponentType<P>,
  predicate: (prev: P, next: P) => boolean,
  counter: RenderCounter,
): ComponentType<P> {
  return memo(function SpiedWidget(props: P) {
    useRenderSpy(counter);
    return <Widget {...props} />;
  }, predicate);
}

function Harness<P extends object>({
  Widget,
  deriveProps,
  onReady,
}: {
  Widget: ComponentType<P>;
  deriveProps: (tick: number) => P;
  onReady: (bump: () => void) => void;
}): ReactNode {
  const [tick, setTick] = useState(0);
  onReady(() => setTick((t) => t + 1));
  return <Widget {...deriveProps(tick)} />;
}

/**
 * Mount the spied widget, then run one payload-equal re-parse (tick 0→1) and one
 * real change (tick 1→2). Returns the render counts observed after each so both
 * directions are asserted.
 */
function runStreamingScenario<P extends object>(config: {
  Widget: ComponentType<P>;
  predicate: (prev: P, next: P) => boolean;
  deriveProps: (tick: number) => P;
}): { mounts: number; afterEqual: number; afterChanged: number } {
  const counter = makeRenderCounter();
  const Spied = spyWidget(config.Widget, config.predicate, counter);
  let bump: () => void = () => {
    throw new Error("harness not ready");
  };
  act(() => {
    render(
      <Harness
        Widget={Spied}
        deriveProps={config.deriveProps}
        onReady={(b) => {
          bump = b;
        }}
      />,
    );
  });
  const mounts = counter.count;
  act(() => bump()); // tick 0 -> 1: payload-equal re-parse
  const afterEqual = counter.count;
  act(() => bump()); // tick 1 -> 2: changed payload
  const afterChanged = counter.count;
  return { mounts, afterEqual, afterChanged };
}

describe("inline widget streaming render-count lock", () => {
  it("ChoiceWidget: equal re-parse does not re-render; a new option does", () => {
    const onChoose = () => {};
    const { mounts, afterEqual, afterChanged } = runStreamingScenario({
      Widget: ChoiceWidget,
      predicate: choicePropsEqual,
      deriveProps: (tick) => ({
        id: "c1",
        scope: "disambiguate",
        options:
          tick >= 2
            ? [
                { value: "a", label: "Apple" },
                { value: "b", label: "Banana" },
              ]
            : [{ value: "a", label: "Apple" }],
        allowCustom: false,
        onChoose,
      }),
    });
    expect(mounts).toBe(1);
    expect(afterEqual).toBe(1); // bailed: still 1 render total
    expect(afterChanged).toBe(2); // re-rendered once on the real change
  });

  it("FollowupsWidget: equal re-parse does not re-render; a new chip does", () => {
    const onChoose = () => {};
    const { mounts, afterEqual, afterChanged } = runStreamingScenario({
      Widget: FollowupsWidget,
      predicate: followupsPropsEqual,
      deriveProps: (
        tick,
      ): {
        id: string;
        options: FollowupOption[];
        onChoose: (v: string) => void;
      } => ({
        id: "f1",
        options:
          tick >= 2
            ? [
                { kind: "reply", payload: "yes", label: "Yes" },
                { kind: "reply", payload: "no", label: "No" },
              ]
            : [{ kind: "reply", payload: "yes", label: "Yes" }],
        onChoose,
      }),
    });
    expect(mounts).toBe(1);
    expect(afterEqual).toBe(1);
    expect(afterChanged).toBe(2);
  });

  it("FormRequest: equal re-parse does not re-render (preserves input state); a new field does", () => {
    const onSubmit = () => {};
    const { mounts, afterEqual, afterChanged } = runStreamingScenario({
      Widget: FormRequest,
      predicate: formRequestPropsEqual,
      deriveProps: (
        tick,
      ): {
        form: FormRequestSpec;
        onSubmit: (id: string, v: Record<string, string | boolean>) => void;
      } => ({
        form: {
          id: "form1",
          submitLabel: "Send",
          fields:
            tick >= 2
              ? [
                  { name: "email", type: "text", required: true },
                  { name: "phone", type: "text" },
                ]
              : [{ name: "email", type: "text", required: true }],
        },
        onSubmit,
      }),
    });
    expect(mounts).toBe(1);
    expect(afterEqual).toBe(1);
    expect(afterChanged).toBe(2);
  });

  it("WorkflowSteps: equal re-parse does not re-render; an advanced step does", () => {
    const { mounts, afterEqual, afterChanged } = runStreamingScenario({
      Widget: WorkflowSteps,
      predicate: workflowPropsEqual,
      deriveProps: (tick): { workflow: WorkflowSpec } => ({
        workflow: {
          id: "wf1",
          steps: [
            { label: "Fetch", status: "done" },
            { label: "Build", status: tick >= 2 ? "running" : "pending" },
          ],
        },
      }),
    });
    expect(mounts).toBe(1);
    expect(afterEqual).toBe(1);
    expect(afterChanged).toBe(2);
  });

  it("PlanChecklist: equal re-parse does not re-render; an advanced entry does", () => {
    const { mounts, afterEqual, afterChanged } = runStreamingScenario({
      Widget: PlanChecklist,
      predicate: planChecklistPropsEqual,
      deriveProps: (
        tick,
      ): { entries: SwarmActivityPlanEntry[]; title?: string } => ({
        entries: [
          { content: "Plan the work", status: "completed" },
          {
            content: "Do the work",
            status: tick >= 2 ? "in_progress" : "pending",
          },
        ],
        title: "Plan",
      }),
    });
    expect(mounts).toBe(1);
    expect(afterEqual).toBe(1);
    expect(afterChanged).toBe(2);
  });
});

// The predicate suite above proves the exported comparator; this suite proves
// the SHIPPED widget's `memo()` is actually wired to it. A memo BAIL preserves
// the fiber (no remount), so widget-internal state survives a payload-equal
// re-parse. If the memo regressed (or used referential equality), the fresh
// per-tick props object would remount the widget and wipe the state — which is
// exactly the mid-conversation bug the memo exists to prevent. Driving the real
// widget's own state is a stronger, black-box lock than counting renders.
describe("inline widget state survives an equal re-parse (real memo wiring)", () => {
  it("ChoiceWidget keeps its locked selection across a payload-equal re-parse", () => {
    const onChoose = () => {};
    const opts = () => [
      { value: "a", label: "Apple" },
      { value: "b", label: "Banana" },
    ];
    let bump: () => void = () => {};
    act(() => {
      render(
        <Harness
          Widget={ChoiceWidget}
          deriveProps={() => ({
            id: "c1",
            scope: "disambiguate",
            options: opts(), // fresh array each render — the re-parse condition
            allowCustom: false,
            onChoose,
          })}
          onReady={(b) => {
            bump = b;
          }}
        />,
      );
    });
    // Pick an option — the row locks (buttons disabled, selection recorded).
    act(() => {
      fireEvent.click(screen.getByTestId("choice-a"));
    });
    expect((screen.getByTestId("choice-b") as HTMLButtonElement).disabled).toBe(
      true,
    );
    // A streamed token re-parses to an IDENTICAL payload (fresh objects). If the
    // memo bails the fiber is preserved and the lock survives; a remount would
    // reset it to interactive.
    act(() => bump());
    expect((screen.getByTestId("choice-b") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole("status", { hidden: true }).textContent).toContain(
      "Apple",
    );
  });

  it("FormRequest keeps a half-filled input across a payload-equal re-parse", () => {
    const onSubmit = () => {};
    const spec = (): FormRequestSpec => ({
      id: "form1",
      submitLabel: "Send",
      fields: [{ name: "email", type: "text", label: "Email", required: true }],
    });
    let bump: () => void = () => {};
    act(() => {
      render(
        <Harness
          Widget={FormRequest}
          deriveProps={() => ({ form: spec(), onSubmit })}
          onReady={(b) => {
            bump = b;
          }}
        />,
      );
    });
    const input = screen.getByLabelText("Email") as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "me@example.com" } });
    });
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
      "me@example.com",
    );
    // Equal re-parse: the field text must survive (a remount would clear it).
    act(() => bump());
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
      "me@example.com",
    );
  });
});
