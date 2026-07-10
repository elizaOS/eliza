/**
 * Value comparators for streamed inline widgets must bail on equivalent fresh
 * payloads and invalidate for every user-visible or callback change.
 */

import { describe, expect, it } from "vitest";
import {
  choicePropsEqual,
  followupsPropsEqual,
  formRequestPropsEqual,
  planChecklistPropsEqual,
  workflowPropsEqual,
} from "./widget-equality";

describe("inline widget structural equality", () => {
  it("compares choice payloads by value and callbacks by identity", () => {
    const onChoose = () => {};
    const base = {
      id: "choice-1",
      scope: "fruit",
      allowCustom: false,
      options: [{ value: "apple", label: "Apple" }],
      onChoose,
    };

    expect(choicePropsEqual(base, base)).toBe(true);
    expect(
      choicePropsEqual(base, { ...base, options: [...base.options] }),
    ).toBe(true);
    expect(choicePropsEqual(base, { ...base, id: "choice-2" })).toBe(false);
    expect(choicePropsEqual(base, { ...base, scope: "vegetable" })).toBe(false);
    expect(choicePropsEqual(base, { ...base, allowCustom: true })).toBe(false);
    expect(choicePropsEqual(base, { ...base, onChoose: () => {} })).toBe(false);
    expect(choicePropsEqual(base, { ...base, options: [] })).toBe(false);
    expect(
      choicePropsEqual(base, {
        ...base,
        options: [{ value: "apple", label: "Green apple" }],
      }),
    ).toBe(false);
  });

  it("compares followup actions and optional handlers", () => {
    const onChoose = () => {};
    const onNavigate = () => {};
    const onPrompt = () => {};
    const base = {
      id: "followups-1",
      options: [{ kind: "reply" as const, payload: "yes", label: "Yes" }],
      onChoose,
      onNavigate,
      onPrompt,
    };

    expect(
      followupsPropsEqual(base, {
        ...base,
        options: base.options.map((option) => ({ ...option })),
      }),
    ).toBe(true);
    expect(followupsPropsEqual(base, { ...base, onNavigate: undefined })).toBe(
      false,
    );
    expect(followupsPropsEqual(base, { ...base, onPrompt: undefined })).toBe(
      false,
    );
    expect(
      followupsPropsEqual(base, {
        ...base,
        options: [{ ...base.options[0], payload: "no" }],
      }),
    ).toBe(false);
  });

  it("compares complete form fields without erasing in-progress input", () => {
    const onSubmit = () => {};
    const base = {
      form: {
        id: "profile",
        title: "Profile",
        description: "Tell us about yourself",
        submitLabel: "Save",
        fields: [
          {
            name: "role",
            type: "select" as const,
            label: "Role",
            placeholder: "Choose",
            required: true,
            options: [{ value: "engineer", label: "Engineer" }],
          },
        ],
      },
      onSubmit,
    };
    const clone = {
      form: {
        ...base.form,
        fields: base.form.fields.map((field) => ({
          ...field,
          options: field.options.map((option) => ({ ...option })),
        })),
      },
      onSubmit,
    };

    expect(formRequestPropsEqual(base, clone)).toBe(true);
    expect(formRequestPropsEqual(base, { ...clone, onSubmit: () => {} })).toBe(
      false,
    );
    expect(
      formRequestPropsEqual(base, {
        ...clone,
        form: {
          ...clone.form,
          fields: [
            {
              ...clone.form.fields[0],
              options: [{ value: "designer", label: "Designer" }],
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("invalidates workflows when a step changes", () => {
    const base = {
      workflow: {
        id: "deploy",
        title: "Deploy",
        steps: [{ label: "Build", status: "pending" as const }],
      },
    };

    expect(workflowPropsEqual(base, structuredClone(base))).toBe(true);
    expect(
      workflowPropsEqual(base, {
        workflow: {
          ...base.workflow,
          steps: [{ label: "Build", status: "running" }],
        },
      }),
    ).toBe(false);
  });

  it("compares checklist title, presentation, content, and status", () => {
    const base = {
      title: "Launch",
      headerless: false,
      entries: [{ content: "Verify", status: "pending" }],
    };

    expect(planChecklistPropsEqual(base, structuredClone(base))).toBe(true);
    expect(planChecklistPropsEqual(base, { ...base, headerless: true })).toBe(
      false,
    );
    expect(
      planChecklistPropsEqual(base, {
        ...base,
        entries: [{ content: "Verify", status: "completed" }],
      }),
    ).toBe(false);
  });
});
