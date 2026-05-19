/**
 * Chart components wrapping Recharts with theme support.
 * Provides chart container, legend, tooltip, and axis components with light/dark theme support.
 */
import * as React from "react";
import * as RechartsPrimitive from "recharts";
declare const THEMES: {
    readonly light: "";
    readonly dark: ".dark";
};
export type ChartConfig = {
    [k in string]: {
        label?: React.ReactNode;
        icon?: React.ComponentType;
    } & ({
        color?: string;
        theme?: never;
    } | {
        color?: never;
        theme: Record<keyof typeof THEMES, string>;
    });
};
declare function ChartContainer({ id, className, children, config, ...props }: React.ComponentProps<"div"> & {
    config: ChartConfig;
    children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}): import("react/jsx-runtime").JSX.Element;
declare const ChartStyle: ({ id, config }: {
    id: string;
    config: ChartConfig;
}) => import("react/jsx-runtime").JSX.Element | null;
declare const ChartTooltip: typeof RechartsPrimitive.Tooltip;
type PayloadItem = {
    type?: string;
    name?: string;
    dataKey?: string;
    value?: number | string;
    color?: string;
    fill?: string;
    payload?: Record<string, unknown>;
    [key: string]: unknown;
};
type ChartTooltipContentProps = {
    active?: boolean;
    payload?: PayloadItem[];
    label?: string | number;
    className?: string;
    indicator?: "line" | "dot" | "dashed";
    hideLabel?: boolean;
    hideIndicator?: boolean;
    labelFormatter?: (value: React.ReactNode, payload: PayloadItem[]) => React.ReactNode;
    labelClassName?: string;
    formatter?: (value: number | string, name: string, item: PayloadItem, index: number) => React.ReactNode;
    color?: string;
    nameKey?: string;
    labelKey?: string;
};
declare function ChartTooltipContent({ active, payload, className, indicator, hideLabel, hideIndicator, label, labelFormatter, labelClassName, formatter, color, nameKey, labelKey, }: ChartTooltipContentProps): import("react/jsx-runtime").JSX.Element | null;
declare const ChartLegend: React.MemoExoticComponent<(outsideProps: RechartsPrimitive.LegendProps) => React.ReactPortal | null>;
type LegendPayloadItem = {
    value?: string;
    type?: string;
    dataKey?: string;
    color?: string;
    [key: string]: unknown;
};
type ChartLegendContentProps = React.ComponentProps<"div"> & {
    payload?: LegendPayloadItem[];
    verticalAlign?: "top" | "bottom";
    hideIcon?: boolean;
    nameKey?: string;
};
declare function ChartLegendContent({ className, hideIcon, payload, verticalAlign, nameKey, }: ChartLegendContentProps): import("react/jsx-runtime").JSX.Element | null;
export { ChartContainer, ChartLegend, ChartLegendContent, ChartStyle, ChartTooltip, ChartTooltipContent, };
//# sourceMappingURL=chart.d.ts.map