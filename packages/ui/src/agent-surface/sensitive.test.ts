/** Verifies agent-surface sensitivity classification through the real module. */
// @vitest-environment jsdom

/**
 * Covers isSensitiveAgentElement: the descriptor.sensitive flag, the
 * data-agent-sensitive attribute, native password / one-time-code input
 * signals, and the free-text scan across descriptor fields, element
 * attributes, and associated form labels. Uses real DOM nodes under jsdom;
 * no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  isSensitiveAgentElement,
  SENSITIVE_AGENT_ELEMENT_REASON,
} from "./sensitive";
import type { AgentElementDescriptor } from "./types";

function makeDescriptor(
  overrides: Partial<AgentElementDescriptor> = {},
): AgentElementDescriptor {
  return { id: "profile.display-name", label: "Display name", ...overrides };
}

describe("isSensitiveAgentElement", () => {
  it("returns true when descriptor.sensitive is set, even without an element", () => {
    expect(
      isSensitiveAgentElement(makeDescriptor({ sensitive: true }), null),
    ).toBe(true);
  });

  it("returns false for a benign descriptor with no element", () => {
    expect(isSensitiveAgentElement(makeDescriptor(), undefined)).toBe(false);
  });

  it("scans every descriptor text field for sensitive wording", () => {
    expect(
      isSensitiveAgentElement(makeDescriptor({ id: "login.token" }), null),
    ).toBe(true);
    expect(
      isSensitiveAgentElement(makeDescriptor({ label: "Access Token" }), null),
    ).toBe(true);
    expect(
      isSensitiveAgentElement(
        makeDescriptor({ label: "PASSWORD", group: "auth" }),
        null,
      ),
    ).toBe(true);
    expect(
      isSensitiveAgentElement(
        makeDescriptor({ group: "secret", label: "Name" }),
        null,
      ),
    ).toBe(true);
    expect(
      isSensitiveAgentElement(
        makeDescriptor({ description: "Your seed phrase backup" }),
        null,
      ),
    ).toBe(true);
  });

  it("returns false for benign and near-miss wording", () => {
    expect(
      isSensitiveAgentElement(makeDescriptor({ label: "Email address" }), null),
    ).toBe(false);
    // Word boundaries: "token" must not match inside "Tokenizer".
    expect(
      isSensitiveAgentElement(
        makeDescriptor({ label: "Tokenizer settings" }),
        null,
      ),
    ).toBe(false);
  });

  it("treats data-agent-sensitive=true and =1 as sensitive", () => {
    for (const value of ["true", "1"]) {
      const el = document.createElement("div");
      el.setAttribute("data-agent-sensitive", value);
      expect(isSensitiveAgentElement(makeDescriptor(), el)).toBe(true);
    }
  });

  it("keeps scanning when data-agent-sensitive is neither true nor 1", () => {
    const marked = document.createElement("div");
    marked.setAttribute("data-agent-sensitive", "false");
    expect(isSensitiveAgentElement(makeDescriptor(), marked)).toBe(false);
    expect(
      isSensitiveAgentElement(makeDescriptor({ label: "bearer" }), marked),
    ).toBe(true);
  });

  it("honours descriptor.sensitive=false while DOM signals stay authoritative", () => {
    const el = document.createElement("input");
    el.type = "password";
    expect(
      isSensitiveAgentElement(makeDescriptor({ sensitive: false }), el),
    ).toBe(true);
  });

  it("flags password inputs by input type", () => {
    const input = document.createElement("input");
    input.type = "password";
    expect(isSensitiveAgentElement(makeDescriptor(), input)).toBe(true);
  });

  it("flags inputs declaring autocomplete=one-time-code", () => {
    const input = document.createElement("input");
    input.setAttribute("autocomplete", "one-time-code");
    expect(isSensitiveAgentElement(makeDescriptor(), input)).toBe(true);
  });

  it("scans element attributes for sensitive wording", () => {
    const cases: Array<[string, string]> = [
      ["name", "refresh_token"],
      ["id", "client-secret"],
      ["aria-label", "API key"],
      ["placeholder", "Enter bearer token"],
      ["autocomplete", "current-password"],
    ];
    for (const [attr, value] of cases) {
      const el = document.createElement("div");
      el.setAttribute(attr, value);
      expect(isSensitiveAgentElement(makeDescriptor(), el)).toBe(true);
    }
  });

  it("scans the text of associated labels for form controls", () => {
    for (const tag of ["input", "textarea", "select"] as const) {
      const control = document.createElement(tag);
      const label = document.createElement("label");
      label.textContent = "Recovery passphrase";
      label.append(control);
      expect(isSensitiveAgentElement(makeDescriptor(), control)).toBe(true);
    }
  });

  it("does not treat label text as associated for non-form elements", () => {
    const label = document.createElement("label");
    label.textContent = "Private key material";
    const section = document.createElement("section");
    label.append(section);
    expect(isSensitiveAgentElement(makeDescriptor(), section)).toBe(false);
  });

  it("matches multi-word terms across separator styles", () => {
    for (const label of ["api_key", "api-key", "api key"]) {
      expect(isSensitiveAgentElement(makeDescriptor({ label }), null)).toBe(
        true,
      );
    }
  });
});

describe("SENSITIVE_AGENT_ELEMENT_REASON", () => {
  it("exposes the shared refusal reason", () => {
    expect(SENSITIVE_AGENT_ELEMENT_REASON).toBe(
      "sensitive element cannot be read or filled through the agent surface",
    );
  });
});
