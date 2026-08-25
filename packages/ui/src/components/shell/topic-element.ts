/** Resolves chat topics by exact dataset value without interpolating untrusted text into selectors. */
export function findTopicElement(
  root: ParentNode | null,
  topic: string,
): HTMLElement | undefined {
  return Array.from(
    root?.querySelectorAll<HTMLElement>("[data-topic]") ?? [],
  ).find((candidate) => candidate.dataset.topic === topic);
}
