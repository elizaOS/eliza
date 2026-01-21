"use client";

import { cn, type JsonValue } from "@polyagent/shared";
import * as React from "react";
import * as RechartsPrimitive from "recharts";

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: "", dark: ".dark" } as const;

/**
 * Chart configuration type for defining chart data series styling.
 *
 * Maps data keys to label, icon, and color/theme configuration.
 */
export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  );
};

type ChartContextProps = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

/**
 * Hook to access chart context.
 *
 * Must be used within a ChartContainer. Returns chart configuration.
 *
 * @returns Chart context with config
 * @throws Error if used outside ChartContainer
 */
function useChart() {
  const context = React.useContext(ChartContext);

  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }

  return context;
}

/**
 * Chart container component for wrapping Recharts charts.
 *
 * Provides chart context and responsive container. Generates unique chart ID
 * and injects CSS variables for theming. Wraps Recharts ResponsiveContainer.
 *
 * @param props - ChartContainer component props
 * @returns Chart container element with context provider
 *
 * @example
 * ```tsx
 * <ChartContainer config={chartConfig}>
 *   <LineChart>...</LineChart>
 * </ChartContainer>
 * ```
 */
function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >["children"];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

/**
 * Chart style component that injects CSS variables for theming.
 *
 * Generates CSS custom properties for chart colors based on config.
 * Supports light/dark theme variants.
 *
 * @param props - ChartStyle component props
 * @returns Style element or null if no color config
 */
const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(
    ([, config]) => config.theme || config.color,
  );

  if (!colorConfig.length) {
    return null;
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color =
      itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ||
      itemConfig.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .join("\n")}
}
`,
          )
          .join("\n"),
      }}
    />
  );
};

/**
 * Chart tooltip component from Recharts.
 *
 * Re-exported Recharts Tooltip primitive.
 */
const ChartTooltip = RechartsPrimitive.Tooltip;

/**
 * Chart tooltip content component with custom styling.
 *
 * Custom tooltip content for charts with indicator types (dot, line, dashed),
 * label formatting, and payload filtering. Supports custom formatters and
 * label display options.
 *
 * @param props - ChartTooltipContent component props
 * @returns Tooltip content element or null if not active
 */
function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: {
  active?: boolean;
  payload?: Array<{
    value?: number | string;
    name?: string;
    dataKey?: string;
    color?: string;
    payload?: Record<string, JsonValue>;
    [key: string]: JsonValue | undefined;
  }>;
  className?: string;
  indicator?: "line" | "dot" | "dashed";
  hideLabel?: boolean;
  hideIndicator?: boolean;
  label?: React.ReactNode;
  labelFormatter?: (
    value: React.ReactNode,
    payload: Array<Record<string, JsonValue>>,
  ) => React.ReactNode;
  labelClassName?: string;
  formatter?: (
    value: number | string,
    name: string,
    item: Record<string, JsonValue>,
    index: number,
    payload: Record<string, JsonValue>,
  ) => React.ReactNode;
  color?: string;
  nameKey?: string;
  labelKey?: string;
}) {
  const { config } = useChart();

  const filteredPayload = React.useMemo(() => {
    if (!payload?.length) return [];

    const seen = new Set<string>();
    return payload.filter((item) => {
      if (item?.value === undefined || item?.value === null) {
        return false;
      }
      const key = `${item?.dataKey ?? item?.name ?? "value"}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }, [payload]);

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || filteredPayload.length === 0) {
      return null;
    }

    const [item] = filteredPayload;
    const key = `${labelKey || item?.dataKey || item?.name || "value"}`;
    const itemConfig = item
      ? getPayloadConfigFromPayload(config, item as JsonValue, key)
      : undefined;
    const value =
      !labelKey && typeof label === "string"
        ? config[label as keyof typeof config]?.label || label
        : itemConfig?.label;

    if (labelFormatter) {
      return (
        <div className={cn("font-medium", labelClassName)}>
          {labelFormatter(
            value,
            (payload ?? []) as Array<Record<string, JsonValue>>,
          )}
        </div>
      );
    }

    if (!value) {
      return null;
    }

    return <div className={cn("font-medium", labelClassName)}>{value}</div>;
  }, [
    label,
    labelFormatter,
    payload,
    hideLabel,
    labelClassName,
    config,
    labelKey,
    filteredPayload,
  ]);

  if (!active || filteredPayload.length === 0) {
    return null;
  }

  const nestLabel = (payload?.length ?? 0) === 1 && indicator !== "dot";

  return (
    <div
      className={cn(
        "grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl",
        className,
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {filteredPayload.map((item, index) => {
          const key = `${nameKey || item.name || item.dataKey || "value"}`;
          const itemConfig = getPayloadConfigFromPayload(
            config,
            item as JsonValue,
            key,
          );
          const indicatorColor = color || item.payload?.fill || item.color;

          return (
            <div
              key={item.dataKey}
              className={cn(
                "flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground",
                indicator === "dot" && "items-center",
              )}
            >
              {formatter && item?.value !== undefined && item.name ? (
                formatter(
                  item.value,
                  item.name,
                  item as Record<string, JsonValue>,
                  index,
                  (item.payload || {}) as Record<string, JsonValue>,
                )
              ) : (
                <>
                  {itemConfig?.icon ? (
                    <itemConfig.icon />
                  ) : (
                    !hideIndicator && (
                      <div
                        className={cn(
                          "shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
                          {
                            "h-2.5 w-2.5": indicator === "dot",
                            "w-1": indicator === "line",
                            "w-0 border-[1.5px] border-dashed bg-transparent":
                              indicator === "dashed",
                            "my-0.5": nestLabel && indicator === "dashed",
                          },
                        )}
                        style={
                          {
                            "--color-bg": indicatorColor,
                            "--color-border": indicatorColor,
                          } as React.CSSProperties
                        }
                      />
                    )
                  )}
                  <div
                    className={cn(
                      "flex flex-1 justify-between leading-none",
                      nestLabel ? "items-end" : "items-center",
                    )}
                  >
                    <div className="grid gap-1.5">
                      {nestLabel ? tooltipLabel : null}
                      <span className="text-muted-foreground">
                        {itemConfig?.label || item.name}
                      </span>
                    </div>
                    {item.value && (
                      <span className="font-medium font-mono text-foreground tabular-nums">
                        {item.value.toLocaleString()}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Chart legend component from Recharts.
 *
 * Re-exported Recharts Legend primitive.
 */
const ChartLegend = RechartsPrimitive.Legend;

/**
 * Chart legend content component with custom styling.
 *
 * Custom legend content for charts with icon support and vertical alignment.
 * Displays legend items with icons or color indicators.
 *
 * @param props - ChartLegendContent component props
 * @returns Legend content element or null if no payload
 */
function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
}: React.ComponentProps<"div"> & {
  payload?: Array<{
    value?: string;
    dataKey?: string;
    color?: string;
    [key: string]: JsonValue | undefined;
  }>;
  verticalAlign?: "top" | "bottom";
  hideIcon?: boolean;
  nameKey?: string;
}) {
  const { config } = useChart();

  const safePayload = payload ?? [];

  if (safePayload.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className,
      )}
    >
      {safePayload.map((item) => {
        const key = `${nameKey || item.dataKey || "value"}`;
        const itemConfig = getPayloadConfigFromPayload(
          config,
          item as JsonValue,
          key,
        );

        return (
          <div
            key={item.value}
            className={cn(
              "flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground",
            )}
          >
            {itemConfig?.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{
                  backgroundColor: item.color,
                }}
              />
            )}
            {itemConfig?.label}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Helper function to extract chart item configuration from payload.
 *
 * Extracts configuration from chart payload data, checking both direct
 * payload properties and nested payload.payload properties.
 *
 * @param config - Chart configuration object
 * @param payload - Payload data from chart
 * @param key - Key to look up in config
 * @returns Chart item configuration or undefined
 */
function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: JsonValue,
  key: string,
) {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const payloadPayload =
    "payload" in payload &&
    typeof payload.payload === "object" &&
    payload.payload !== null
      ? payload.payload
      : undefined;

  let configLabelKey: string = key;

  const payloadObj = payload as Record<string, JsonValue>;
  const payloadPayloadObj = payloadPayload as
    | Record<string, JsonValue>
    | undefined;

  if (key in payloadObj && typeof payloadObj[key] === "string") {
    configLabelKey = payloadObj[key] as string;
  } else if (
    payloadPayloadObj &&
    key in payloadPayloadObj &&
    typeof payloadPayloadObj[key] === "string"
  ) {
    configLabelKey = payloadPayloadObj[key] as string;
  }

  return configLabelKey in config
    ? config[configLabelKey]
    : config[key as keyof typeof config];
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
};
