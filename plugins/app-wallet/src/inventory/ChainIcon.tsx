import type * as React from "react";
import { resolveChainKey } from "./chainConfig.ts";

export type ChainIconSize = "sm" | "md" | "lg";

export interface ChainIconProps {
  chain: string;
  size?: ChainIconSize;
  className?: string;
}

const SIZE_CLASSES: Record<ChainIconSize, string> = {
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

/* Per-chain size overrides for visual balance.
 * Some SVGs appear smaller at the same pixel size due to viewBox proportions. */
const SIZE_OVERRIDES: Partial<
  Record<string, Partial<Record<ChainIconSize, string>>>
> = {
  bsc: { sm: "h-5 w-5", md: "h-6 w-6", lg: "h-7 w-7" },
  ethereum: { lg: "h-7 w-7" },
  base: { lg: "h-7 w-7" },
};

interface ChainSvgDef {
  viewBox: string;
  paths: string[];
}

const CHAIN_SVGS: Record<string, ChainSvgDef> = {
  ethereum: {
    viewBox: "0 0 24 24",
    paths: [
      "M12 1.5l-7 10.167L12 15.5l7-3.833L12 1.5zM5 13.5L12 22.5l7-9-7 3.833L5 13.5z",
    ],
  },
  base: {
    viewBox: "0 0 146 146",
    paths: [
      "M73.323 123.729C101.617 123.729 124.553 100.832 124.553 72.5875C124.553 44.343 101.617 21.4463 73.323 21.4463C46.4795 21.4463 24.4581 42.0558 22.271 68.2887H89.9859V76.8864H22.271C24.4581 103.119 46.4795 123.729 73.323 123.729Z",
    ],
  },
  bsc: {
    viewBox: "0 0 2496 2496",
    paths: [
      "M685.9 1248l0.9 330 280.4 165v193.2l-444.5-260.7v-524L685.9 1248zM685.9 918v192.3l-163.3-96.6V821.4l163.3-96.6 164.1 96.6L685.9 918zM1084.3 821.4l163.3-96.6 164.1 96.6-164.1 96.6-163.3-96.6z",
      "M803.9 1509.6v-193.2l163.3 96.6v192.3L803.9 1509.6zM1084.3 1812.2l163.3 96.6 164.1-96.6v192.3l-164.1 96.6-163.3-96.6v-192.3zM1645.9 821.4l163.3-96.6 164.1 96.6v192.3l-164.1 96.6V918L1645.9 821.4zM1809.2 1578l0.9-330 163.3-96.6v524l-444.5 260.7v-193.2L1809.2 1578z",
      "M1692.1 986.4l0.9 193.2-281.2 165v330.8l-163.3 95.7-163.3-95.7v-330.8l-281.2-165V986.4L968 889.8l279.5 165.8 281.2-165.8 164.1 96.6h-0.7zM803.9 656.5l443.7-261.6 444.5 261.6-163.3 96.6-281.2-165.8-280.4 165.8-163.3-96.6z",
    ],
  },
  avax: {
    viewBox: "0 0 24 24",
    paths: ["M12 3L2 21h6l4-7 4 7h6L12 3z"],
  },
  solana: {
    viewBox: "0 0 397.7 311.7",
    paths: [
      "M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 237.9z",
      "M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z",
      "M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1L333.1 120.1z",
    ],
  },
};

export function ChainIcon({
  chain,
  size = "md",
  className = "",
}: ChainIconProps): React.ReactElement | null {
  const key = resolveChainKey(chain);
  if (!key) return null;
  const def = CHAIN_SVGS[key];
  if (!def) return null;

  const sizeClass = SIZE_OVERRIDES[key]?.[size] ?? SIZE_CLASSES[size];

  return (
    <svg
      viewBox={def.viewBox}
      fill="currentColor"
      className={`${sizeClass} ${className}`.trim()}
      aria-hidden="true"
    >
      {def.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
