/**
 * Cross-platform country flag renderer for homepage phone-number pickers.
 */
import { getCountryFlagPath } from "@/lib/countries";

interface CountryFlagProps {
  countryCode: string;
  className?: string;
  title: string;
}

export function CountryFlag({
  countryCode,
  className,
  title,
}: CountryFlagProps) {
  const flagPath = getCountryFlagPath(countryCode);

  return (
    <span
      className={`${className ?? ""} inline-flex items-center justify-center overflow-hidden`}
      title={title}
      role="img"
      aria-label={title}
    >
      {flagPath ? (
        <img
          src={flagPath}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          className="size-full object-cover"
        />
      ) : (
        countryCode.toUpperCase()
      )}
    </span>
  );
}
