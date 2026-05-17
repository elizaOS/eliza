import React from "react";

type MovingBorderButtonProps = {
  borderRadius?: string;
  children: React.ReactNode;
  as?: React.ElementType;
  containerClassName?: string;
  borderClassName?: string;
  duration?: number;
  className?: string;
  [key: string]: unknown;
};
export declare function Button({
  borderRadius,
  children,
  as,
  containerClassName,
  borderClassName,
  duration,
  className,
  ...otherProps
}: MovingBorderButtonProps): React.ReactElement<
  any,
  string | React.JSXElementConstructor<any>
>;
export declare const MovingBorder: ({
  children,
  duration,
  rx,
  ry,
  ...otherProps
}: {
  children: React.ReactNode;
  duration?: number;
  rx?: string;
  ry?: string;
  [key: string]: unknown;
}) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=moving-border.d.ts.map
