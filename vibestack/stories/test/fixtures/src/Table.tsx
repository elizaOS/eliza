export interface Row { id: number }

export function Table({ rows, sort }: { rows: Row[]; sort: { by: string } }) {
  return <table data-sort={sort.by}>{rows.map((row) => <tr key={row.id} />)}</table>;
}
