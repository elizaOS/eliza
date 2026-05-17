interface SectionHeaderProps {
  label: string;
  title?: string | React.ReactNode;
  description?: string | React.ReactNode;
  className?: string;
  labelClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  align?: "left" | "center" | "right";
}
export declare function SectionHeader({
  label,
  title,
  description,
  className,
  labelClassName,
  titleClassName,
  descriptionClassName,
  align,
}: SectionHeaderProps): import("react/jsx-runtime").JSX.Element;
export declare function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=section-header.d.ts.map
