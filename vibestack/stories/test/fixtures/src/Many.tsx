import type { Hue, Shade } from "@kit/shades.ts";

export function Many({ shade, hue, dense }: { shade: Shade; hue?: Hue; dense?: boolean }) {
  return <i data-shade={shade} data-hue={hue} data-dense={dense} />;
}
