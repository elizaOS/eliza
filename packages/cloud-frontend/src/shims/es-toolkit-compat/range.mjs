export default function range(start, end, step) {
  let from = start;
  let to = end;
  if (to === undefined) {
    from = 0;
    to = start;
  }
  const stride = step ?? (from < to ? 1 : -1);
  if (stride === 0) return [];
  const values = [];
  if (stride > 0) {
    for (let value = from; value < to; value += stride) values.push(value);
  } else {
    for (let value = from; value > to; value += stride) values.push(value);
  }
  return values;
}
