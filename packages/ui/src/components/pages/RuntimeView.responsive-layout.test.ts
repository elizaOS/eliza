/** Guards the runtime summary's container-aware columns and readable registration-order rows. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runtimeViewSource = readFileSync(
  new URL("./RuntimeView.tsx", import.meta.url),
  "utf8",
);
const orderCardSource = runtimeViewSource.slice(
  runtimeViewSource.indexOf("function OrderCard"),
  runtimeViewSource.indexOf("function ServicesOrderCard"),
);

describe("RuntimeView responsive summary layout", () => {
  it("sizes summary columns from available content width instead of viewport width", () => {
    expect(runtimeViewSource).toContain(
      "grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]",
    );
    expect(runtimeViewSource).not.toContain("md:grid-cols-2");
  });

  it("keeps registration-order labels intact inside a horizontal scroller", () => {
    expect(orderCardSource).toContain(
      'className="min-w-max whitespace-nowrap text-txt"',
    );
    expect(orderCardSource).not.toContain(
      'className="min-w-0 break-words text-txt"',
    );
  });
});
