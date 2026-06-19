/// <reference types="vite/client" />

declare module "prismjs" {
  const Prism: {
    highlightAll(): void;
  };
  export default Prism;
}

declare module "prismjs/components/prism-typescript";

declare module "recharts" {
  import type { ComponentType, ReactNode } from "react";

  type RechartsProps = Record<string, unknown> & {
    children?: ReactNode;
  };
  type RechartsComponent = ComponentType<RechartsProps>;

  export const CartesianGrid: RechartsComponent;
  export const Legend: RechartsComponent;
  export const Line: RechartsComponent;
  export const LineChart: RechartsComponent;
  export const ResponsiveContainer: RechartsComponent;
  export const Tooltip: RechartsComponent;
  export const XAxis: RechartsComponent;
  export const YAxis: RechartsComponent;
}
