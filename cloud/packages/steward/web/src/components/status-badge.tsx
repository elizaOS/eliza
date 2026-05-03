"use client";

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  pending: {
    label: "Pending",
    color: "text-amber-400",
    bg: "bg-amber-400/10",
  },
  approved: {
    label: "Approved",
    color: "text-emerald-400",
    bg: "bg-emerald-400/10",
  },
  rejected: {
    label: "Rejected",
    color: "text-red-400",
    bg: "bg-red-400/10",
  },
  signed: {
    label: "Signed",
    color: "text-emerald-400",
    bg: "bg-emerald-400/10",
  },
  broadcast: {
    label: "Broadcast",
    color: "text-violet-400",
    bg: "bg-violet-400/10",
  },
  confirmed: {
    label: "Confirmed",
    color: "text-emerald-300",
    bg: "bg-emerald-300/10",
  },
  failed: {
    label: "Failed",
    color: "text-orange-400",
    bg: "bg-orange-400/10",
  },
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className = "" }: StatusBadgeProps) {
  const config = statusConfig[status] || {
    label: status,
    color: "text-text-tertiary",
    bg: "bg-bg-surface",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium tracking-wide ${config.color} ${config.bg} ${className}`}
    >
      <span
        className={`w-1 h-1 rounded-full ${config.color.replace("text-", "bg-")} ${
          status === "pending" ? "animate-pulse" : ""
        }`}
      />
      {config.label}
    </span>
  );
}
