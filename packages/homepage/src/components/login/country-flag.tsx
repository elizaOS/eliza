import { hasFlag } from "country-flag-icons";
import * as FlagComponents from "country-flag-icons/react/3x2";
import type * as React from "react";

const FlagMap = FlagComponents as Record<
  string,
  React.ComponentType<React.SVGAttributes<SVGSVGElement>>
>;

interface CountryFlagProps {
  countryCode: string;
  className?: string;
  title?: string;
}

export function CountryFlag({
  countryCode,
  className,
  title,
}: CountryFlagProps) {
  const key = countryCode.replace(/-/g, "_");
  const Flag = FlagMap[key];

  if (!hasFlag(countryCode) || !Flag) {
    return (
      <span className={className} title={title ?? countryCode} aria-hidden>
        {countryCode}
      </span>
    );
  }

  return (
    <span title={title ?? countryCode}>
      <Flag className={className} />
    </span>
  );
}
