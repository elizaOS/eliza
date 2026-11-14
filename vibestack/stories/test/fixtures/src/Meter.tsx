export interface MeterProps {
  value: number;
  unit: "kb" | "mb";
  loading?: boolean;
  error?: string;
}

export const Meter = ({ value, unit, loading, error }: MeterProps) => <output aria-busy={loading}>{error ?? `${value} ${unit}`}</output>;
