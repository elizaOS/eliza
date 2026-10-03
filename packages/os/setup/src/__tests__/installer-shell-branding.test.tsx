import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstallerShell } from "../components/InstallerShell";

describe("InstallerShell branding and language", () => {
  it("uses the canonical Eliza lockup and clear device choices", () => {
    const html = renderToStaticMarkup(
      <InstallerShell serverUrl="http://127.0.0.1:3743" />,
    );

    expect(html).toContain("./brand/logos/eliza_logotext.svg");
    expect(html).toContain("Install elizaOS");
    expect(html).toContain("Computer");
    expect(html).toContain("Android");
    expect(html).toContain("iPhone &amp; iPad");
    expect(html).toContain("review the exact drive");
    expect(html).not.toContain("Safe, guided setup");
    expect(html).not.toContain("💾");
    expect(html).not.toContain("🍎");
  });
});
