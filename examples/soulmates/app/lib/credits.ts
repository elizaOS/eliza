export type CreditPack = {
  id: "starter" | "standard" | "plus";
  label: string;
  amount: number;
  credits: number;
  description: string;
};

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "starter",
    label: "$10",
    amount: 1000,
    credits: 100,
    description: "100 credits for priority matching",
  },
  {
    id: "standard",
    label: "$25",
    amount: 2500,
    credits: 300,
    description: "300 credits with 20% bonus",
  },
  {
    id: "plus",
    label: "$60",
    amount: 6000,
    credits: 800,
    description: "800 credits with 33% bonus",
  },
];

export const getCreditPack = (id: string): CreditPack | null =>
  CREDIT_PACKS.find((p) => p.id === id) ?? null;

export type CreditSpendOption = {
  id: "priority_match" | "priority_schedule" | "filters" | "insight";
  label: string;
  cost: number;
  description: string;
  reason:
    | "spend_priority_match"
    | "spend_priority_schedule"
    | "spend_filters"
    | "spend_insight";
};

export const CREDIT_SPEND_OPTIONS: CreditSpendOption[] = [
  {
    id: "priority_match",
    label: "Priority matching",
    cost: 25,
    description: "Move to the front of the next matching cycle",
    reason: "spend_priority_match",
  },
  {
    id: "priority_schedule",
    label: "Priority scheduling",
    cost: 15,
    description: "Prioritize rescheduling within 24 hours",
    reason: "spend_priority_schedule",
  },
  {
    id: "filters",
    label: "Expanded filters",
    cost: 10,
    description: "Unlock additional filters for one cycle",
    reason: "spend_filters",
  },
  {
    id: "insight",
    label: "Additional insights",
    cost: 8,
    description: "Request one extra insight from Ori",
    reason: "spend_insight",
  },
];

export const getSpendOption = (id: string): CreditSpendOption | null =>
  CREDIT_SPEND_OPTIONS.find((option) => option.id === id) ?? null;
