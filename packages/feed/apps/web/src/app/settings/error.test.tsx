import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsError from "./error";

describe("SettingsError", () => {
  it("renders settings-specific recovery copy", () => {
    const html = renderToStaticMarkup(
      <SettingsError
        error={new Error("No matching key. session topic does not exist")}
        reset={() => {}}
      />,
    );

    expect(html).toContain("Settings unavailable");
    expect(html).toContain("Reload page");
    expect(html).toContain("Go home");
  });

  it("renders the error digest when present", () => {
    const html = renderToStaticMarkup(
      <SettingsError
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={() => {}}
      />,
    );

    expect(html).toContain("Error ID: abc123");
  });
});
