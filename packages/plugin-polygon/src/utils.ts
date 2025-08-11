export function parseBigIntString(value: unknown, unitName: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error(`Invalid ${unitName} amount: Must be a string representing an integer.`);
  }
  try {
    return BigInt(value);
  } catch (e) {
    throw new Error(`Invalid ${unitName} amount: Cannot parse '${value}' as BigInt.`);
  }
}
