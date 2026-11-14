import { Schema } from "effect";
import type { ComponentMeta } from "../../../meta.ts";
import type { MeterProps } from "./Meter.tsx";

const full = 100;

export const meta: ComponentMeta<MeterProps> = {
  args: { unit: "mb" },
  examples: { "Half full": { value: 50 } },
  states: { Failed: { value: 0, unit: "kb", error: "No disk" } },
  bounds: { value: [0, full] },
  schema: Schema.Struct({ value: Schema.Int }),
  decorator: (story) => story(),
  play: { "Half full": () => undefined },
};
