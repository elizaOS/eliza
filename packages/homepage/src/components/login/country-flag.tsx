/**
 * Country flag renderer for the homepage phone-number picker.
 */
interface CountryFlagProps {
  countryCode: string;
  className?: string;
  title?: string;
}

function getCountryFlag(countryCode: string): string {
  const normalized = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return countryCode;

  return String.fromCodePoint(
    ...normalized.split("").map((char) => 127397 + char.charCodeAt(0)),
  );
}

export function CountryFlag({
  countryCode,
  className,
  title,
}: CountryFlagProps) {
  return (
    <span
      className={`${className ?? ""} inline-flex items-center justify-center text-base leading-none`}
      title={title ?? countryCode}
      role="img"
      aria-label={title ?? countryCode}
    >
      {getCountryFlag(countryCode)}
    </span>
  );
}
