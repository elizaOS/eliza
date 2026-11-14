export function Chip({ text, on = false }: { text: string | number; on?: boolean }) {
  return <b aria-pressed={on}>{text}</b>;
}
