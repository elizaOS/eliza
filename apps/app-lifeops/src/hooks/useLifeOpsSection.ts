import { useCallback, useState } from "react";

export type LifeOpsSection =
  | "dashboard"
  | "calendar"
  | "inbox"
  | "reminders"
  | "settings";

export const LIFEOPS_SECTIONS: LifeOpsSection[] = [
  "dashboard",
  "calendar",
  "inbox",
  "reminders",
  "settings",
];

function isLifeOpsSection(value: unknown): value is LifeOpsSection {
  return (
    typeof value === "string" &&
    (LIFEOPS_SECTIONS as string[]).includes(value)
  );
}

export function useLifeOpsSection(initial?: string | null) {
  const resolved: LifeOpsSection = isLifeOpsSection(initial)
    ? initial
    : "dashboard";
  const [section, setSection] = useState<LifeOpsSection>(resolved);

  const navigate = useCallback((next: LifeOpsSection) => {
    setSection(next);
  }, []);

  return { section, navigate };
}
