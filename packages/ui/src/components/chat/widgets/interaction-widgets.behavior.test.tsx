// @vitest-environment jsdom

/**
 * Real interaction tests for the in-chat interaction widgets: they render the
 * widget, drive every input (type text, set numbers, toggle checkboxes, pick
 * options, type a custom answer) and click every button, then assert the exact
 * callback payload the host sends back. No behavior is mocked away — the widget
 * logic (validation, single-decision locking, custom input) runs for real.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceWidget } from "./ChoiceWidget";
import type { FormRequestSpec } from "./form-request";
import { FormRequest } from "./form-request";

// radix Select uses pointer-capture APIs jsdom doesn't implement; polyfill them
// so the option list can actually open and be clicked.
beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  // radix primitives (Checkbox/Select) read element size via ResizeObserver,
  // which jsdom does not implement.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});
afterEach(cleanup);

const form: FormRequestSpec = {
  id: "connect-repo",
  title: "Connect a repository",
  description: "Where should the agent work?",
  submitLabel: "Save",
  fields: [
    { name: "repo", type: "text", label: "Repo URL", required: true },
    { name: "branch", type: "text", label: "Branch", placeholder: "main" },
    { name: "depth", type: "number", label: "Clone depth" },
    { name: "private", type: "checkbox", label: "Private repo" },
  ],
};

describe("FormRequest — every input + submit", () => {
  it("collects text, number, and checkbox values and submits them", () => {
    const onSubmit = vi.fn();
    render(<FormRequest form={form} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Repo URL"), {
      target: { value: "github.com/eliza/agent" },
    });
    fireEvent.change(screen.getByLabelText("Branch"), {
      target: { value: "feat/x" },
    });
    fireEvent.change(screen.getByLabelText("Clone depth"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByLabelText("Private repo"));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("connect-repo", {
      repo: "github.com/eliza/agent",
      branch: "feat/x",
      depth: "5",
      private: true,
    });
  });

  it("blocks submit and shows an error when a required field is empty", () => {
    const onSubmit = vi.fn();
    render(<FormRequest form={form} onSubmit={onSubmit} />);

    // leave required "Repo URL" empty. Submit the form directly so our JS
    // validation runs (a click is intercepted by the native `required` gate
    // before the handler fires); both gates block the send either way.
    fireEvent.submit(screen.getByTestId("form-request"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Repo URL is required/i)).toBeTruthy();
  });

  it("locks after a successful submit (no double-send)", () => {
    const onSubmit = vi.fn();
    render(<FormRequest form={form} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Repo URL"), {
      target: { value: "github.com/eliza/agent" },
    });

    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Submitted" })).toBeTruthy();
  });

  it("renders a select field's options", () => {
    const onSubmit = vi.fn();
    const withSelect: FormRequestSpec = {
      ...form,
      fields: [
        {
          name: "provider",
          type: "select",
          label: "Provider",
          options: [
            { label: "GitHub", value: "gh" },
            { label: "GitLab", value: "gl" },
          ],
        },
      ],
    };
    render(<FormRequest form={withSelect} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText("Provider"));
    // the option list is open; both options are present (radix also keeps a
    // hidden native option, so there may be more than one node per label)
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GitLab").length).toBeGreaterThan(0);
  });
});

describe("ChoiceWidget — pick an option", () => {
  const options = [
    { value: "ship", label: "Ship it" },
    { value: "cancel", label: "Cancel" },
  ];

  it("reports the chosen value", () => {
    const onChoose = vi.fn();
    render(
      <ChoiceWidget
        id="c1"
        scope="approve"
        options={options}
        onChoose={onChoose}
      />,
    );
    fireEvent.click(screen.getByTestId("choice-ship"));
    expect(onChoose).toHaveBeenCalledWith("ship");
  });

  it("locks every option after the first pick (one decision per prompt)", () => {
    const onChoose = vi.fn();
    render(
      <ChoiceWidget
        id="c1"
        scope="approve"
        options={options}
        onChoose={onChoose}
      />,
    );
    fireEvent.click(screen.getByTestId("choice-ship"));
    // a second click on either option is a no-op
    fireEvent.click(screen.getByTestId("choice-cancel"));
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByTestId("choice-cancel") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/Ship it/);
  });
});

describe("ChoiceWidget — put their own in (allowCustom)", () => {
  const options = [{ value: "a", label: "Option A" }];

  it("has no custom affordance unless allowCustom is set", () => {
    render(
      <ChoiceWidget id="c1" scope="s" options={options} onChoose={vi.fn()} />,
    );
    expect(screen.queryByTestId("choice-custom-open")).toBeNull();
  });

  it("lets the user type their own answer and submits it", () => {
    const onChoose = vi.fn();
    render(
      <ChoiceWidget
        id="c1"
        scope="s"
        options={options}
        onChoose={onChoose}
        allowCustom
      />,
    );
    // reveal the input, type a custom answer, send it
    fireEvent.click(screen.getByTestId("choice-custom-open"));
    fireEvent.change(screen.getByTestId("choice-custom-input"), {
      target: { value: "my own plan" },
    });
    fireEvent.click(screen.getByTestId("choice-custom-send"));

    expect(onChoose).toHaveBeenCalledWith("my own plan");
    // and the row locks afterward
    expect(screen.getByRole("status").textContent).toMatch(/my own plan/);
  });

  it("submits a custom answer on Enter and ignores empty input", () => {
    const onChoose = vi.fn();
    render(
      <ChoiceWidget
        id="c1"
        scope="s"
        options={options}
        onChoose={onChoose}
        allowCustom
      />,
    );
    fireEvent.click(screen.getByTestId("choice-custom-open"));
    const input = screen.getByTestId("choice-custom-input");

    // empty Enter is a no-op
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChoose).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "ship custom" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith("ship custom");
  });
});
