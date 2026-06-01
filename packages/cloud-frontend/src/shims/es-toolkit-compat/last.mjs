export default function last(array) {
  return array == null || array.length === 0
    ? undefined
    : array[array.length - 1];
}
