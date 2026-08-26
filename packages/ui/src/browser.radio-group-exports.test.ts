/** Verifies the browser facade exposes the canonical radio controls consumed by plugin view bundles. */

import { describe, expect, it } from "vitest";
import {
  RadioGroup as BrowserRadioGroup,
  RadioGroupItem as BrowserRadioGroupItem,
} from "./browser.ts";
import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group.tsx";

describe("browser radio-group exports", () => {
  it("preserves the canonical primitive identities", () => {
    expect(BrowserRadioGroup).toBe(RadioGroup);
    expect(BrowserRadioGroupItem).toBe(RadioGroupItem);
  });
});
