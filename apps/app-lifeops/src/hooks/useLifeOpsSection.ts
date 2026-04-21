import { useCallback, useState } from "react";

export type LifeOpsSection =
  | "overview"
  | "setup"
  | "reminders"
  | "calendar"
  | "messages";

export const LIFEOPS_SECTIONS: LifeOpsSection[] = [
  "overview",
  "setup",
  "reminders",
  "calendar",
  "messages",
];

function isLifeOpsSection(value: unknown): value is LifeOpsSection {
  return (
    typeof value === "string" && (LIFEOPS_SECTIONS as string[]).includes(value)
  );
}

export function useLifeOpsSection(initial?: string | null) {
  const resolved: LifeOpsSection = isLifeOpsSection(initial)
    ? initial
    : "overview";
  const [section, setSection] = useState<LifeOpsSection>(resolved);

  const navigate = useCallback((next: LifeOpsSection) => {
    setSection(next);
  }, []);

  return { section, navigate };
}
